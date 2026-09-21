"use client";

import * as React from "react";
import { useT } from "@/lib/i18n";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BellRing,
  CheckCircle2,
  Circle,
  ClipboardList,
  Trophy,
  Users,
  Video,
} from "lucide-react";

type ReadinessVideoItem = {
  id: string;
  title: string;
  titleAr: string;
  requiredPercent: number;
  trackable: boolean;
  currentPercent: number;
  completed: boolean;
  requirementMode: string;
  applicability: string;
  attendanceStatus: string | null;
  reviewStatus: string | null;
  finalized: boolean;
};

type ReadinessRow = {
  studentId: string;
  studentName: string;
  groupName: string | null;
  ready: boolean;
  overridden: boolean;
  video: {
    required: boolean;
    done: boolean;
    value: number;
    requiredCount: number;
    completedCount: number;
    items: ReadinessVideoItem[];
    exempt: ReadinessVideoItem[];
  };
  quiz: { required: boolean; done: boolean; pending: { id: string; title: string; titleAr: string }[] };
  homework: { required: boolean; done: boolean; pending: { id: string; title: string; titleAr: string }[] };
};

type ReadinessPayload = {
  lesson: { id: string; title: string; titleAr: string; courseId: string };
  students: ReadinessRow[];
};

type LessonOption = {
  id: string;
  title: string;
  titleAr: string;
  officialCode: string | null;
};

/**
 * Sentinel item values: Radix Select items need non-empty values, while the
 * lesson/group filters legitimately clear to "" — the sentinel round-trips
 * through onValueChange so the state shape never changes.
 */
const READINESS_NO_LESSON = "__no_lesson__";
const READINESS_NO_GROUP = "__no_group__";

/**
 * Teacher lesson-readiness (view `teacher-readiness`): pick one of MY lessons,
 * see every student of MY groups in its course with their LIVE canonical
 * requirement states (video watch % + absence applicability, quiz pass,
 * homework submission), filter by status/group, and remind a not-ready
 * student — the reminder is a teacher note to the LINKED PARENTS through the
 * existing fan-out (teachers cannot message students directly).
 *
 * States only, never content: no video bytes/urls, no quiz questions, no
 * homework attachments cross this surface.
 */
export function TeacherReadinessView() {
  const tr = useT();
  const [lessons, setLessons] = React.useState<LessonOption[]>([]);
  const [lessonsLoading, setLessonsLoading] = React.useState(true);
  const [lessonId, setLessonId] = React.useState("");
  const [data, setData] = React.useState<ReadinessPayload | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [filter, setFilter] = React.useState<"ALL" | "READY" | "NOT_READY">("ALL");
  const [groupFilter, setGroupFilter] = React.useState("ALL");
  const [reminding, setReminding] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/teacher/lessons")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        setLessons(Array.isArray(d?.lessons) ? d.lessons : []);
        setLessonsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLessons([]);
        setLessonsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Lesson switch, adjusted during render (never as a sync effect write):
  // clearing the lesson clears the payload; picking one reloads with the
  // filter reset. The fetch effect below only subscribes.
  const [readinessKey, setReadinessKey] = React.useState(lessonId);
  if (readinessKey !== lessonId) {
    setReadinessKey(lessonId);
    if (!lessonId) {
      setData(null);
    } else {
      setLoading(true);
      setGroupFilter("ALL");
    }
  }

  React.useEffect(() => {
    if (!lessonId) return;
    let cancelled = false;
    fetch(`/api/teacher/lessons/${encodeURIComponent(lessonId)}/readiness`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  const groups = React.useMemo(() => {
    const names = new Set<string>();
    for (const s of data?.students ?? []) names.add(s.groupName ?? "");
    return [...names].sort();
  }, [data]);

  const rows = (data?.students ?? []).filter(
    (s) =>
      (filter === "ALL" ||
        (filter === "READY" ? s.ready : !s.ready)) &&
      (groupFilter === "ALL" || (s.groupName ?? "") === groupFilter)
  );

  const remind = async (studentId: string) => {
    if (!lessonId || reminding) return;
    setReminding(studentId);
    try {
      const res = await fetch("/api/teacher/readiness/remind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, lessonId }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error((d && d.error) || "teacher.readiness.remind");
      toast.success(tr("teacher.readiness.reminded"));
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : tr("teacher.readiness.remind"));
    } finally {
      setReminding(null);
    }
  };

  const absenceNote = (v: ReadinessVideoItem): string | null => {
    if (v.requirementMode !== "ABSENT_STUDENTS") return null;
    if (v.applicability === "EXEMPT_EXCUSED") return tr("teacher.readiness.exempt");
    if (v.applicability !== "REQUIRED_ABSENT") return tr("teacher.readiness.exempt");
    const review = (v.reviewStatus ?? "").toUpperCase();
    if (review === "UNEXCUSED") return tr("teacher.readiness.absent");
    return tr("teacher.readiness.absentPending");
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="w-5 h-5 text-primary" />
            {tr("teacher.readiness.title")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">{tr("teacher.readiness.subtitle")}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label htmlFor="readiness-lesson">{tr("teacher.readiness.pickLesson")}</Label>
            {/* Themed Select (never native): a native option popup ignores
                the dark theme. The placeholder stays re-selectable through
                a sentinel, so clearing the lesson keeps working exactly as
                before. (Kept OUTSIDE the parenthesized branch below: a
                leading JSX comment there parses as an object literal and
                breaks the following element.) */}
            {lessonsLoading ? (
              <Skeleton className="mt-1 h-9 w-full" />
            ) : (
              <Select
                value={lessonId || READINESS_NO_LESSON}
                onValueChange={(v) => setLessonId(v === READINESS_NO_LESSON ? "" : v)}
              >
                <SelectTrigger id="readiness-lesson" className="mt-1 w-full min-w-0">
                  <SelectValue placeholder={tr("teacher.readiness.pickLesson")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={READINESS_NO_LESSON}>{tr("teacher.readiness.pickLesson")}</SelectItem>
                  {lessons.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {(l.officialCode ? `${l.officialCode} — ` : "") + (l.titleAr || l.title)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {data && (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="readiness-group">{tr("teacher.readiness.pickGroup")}</Label>
                {/* Themed Select; an unnamed group ("") rides a sentinel so the
                    empty value keeps filtering exactly as before. */}
                <Select
                  value={groupFilter || READINESS_NO_GROUP}
                  onValueChange={(v) => setGroupFilter(v === READINESS_NO_GROUP ? "" : v)}
                >
                  <SelectTrigger id="readiness-group" className="mt-1 w-full min-w-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{tr("teacher.readiness.filterAll")}</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g} value={g || READINESS_NO_GROUP}>
                        {g || tr("teacher.readiness.filterAll")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-1.5" role="group" aria-label={tr("teacher.readiness.title")}>
                {(
                  [
                    { value: "ALL", label: tr("teacher.readiness.filterAll") },
                    { value: "READY", label: tr("teacher.readiness.filterReady") },
                    { value: "NOT_READY", label: tr("teacher.readiness.filterNotReady") },
                  ] as const
                ).map((f) => (
                  <Button
                    key={f.value}
                    size="sm"
                    variant={filter === f.value ? "default" : "outline"}
                    onClick={() => setFilter(f.value)}
                  >
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {lessonId && loading && (
        <Card>
          <CardContent className="space-y-2 py-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </CardContent>
        </Card>
      )}

      {data && !loading && (
        <div className="space-y-2">
          {rows.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                {tr("teacher.readiness.filterAll")} — 0
              </CardContent>
            </Card>
          )}
          {rows.map((s) => (
            <Card key={s.studentId}>
              <CardContent className="space-y-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{s.studentName}</span>
                  {s.groupName && (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {s.groupName}
                    </Badge>
                  )}
                  {s.ready ? (
                    <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 text-[10px]">
                      <CheckCircle2 className="w-3 h-3 me-1" />
                      {tr("teacher.readiness.ready")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400 border-amber-500/30">
                      <Circle className="w-3 h-3 me-1" />
                      {tr("teacher.readiness.notReady")}
                    </Badge>
                  )}
                  {s.overridden && (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {tr("teacher.readiness.overridden")}
                    </Badge>
                  )}
                  <span className="flex-1" />
                  {!s.ready && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={reminding === s.studentId}
                      onClick={() => remind(s.studentId)}
                    >
                      <BellRing className="w-3.5 h-3.5 me-1.5" />
                      {tr("teacher.readiness.remind")}
                    </Button>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-border/60 p-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <Video className="w-3.5 h-3.5 text-muted-foreground" />
                      {tr("teacher.readiness.video")}
                      {!s.video.required && (
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {tr("course.224")}
                        </span>
                      )}
                    </div>
                    {s.video.required && (
                      <div className="mt-1 space-y-1">
                        <div className="flex items-center gap-2">
                          {s.video.done ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-primary shrink-0" />
                          ) : (
                            <Circle className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
                          )}
                          <Progress value={s.video.value} className="h-1.5 flex-1" />
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            {s.video.completedCount}/{s.video.requiredCount}
                          </span>
                        </div>
                        {s.video.items.map((v) => (
                          <div key={v.id} className="text-[11px] text-muted-foreground">
                            <span className="text-foreground/90">{v.titleAr || v.title}</span>
                            {" — "}
                            <span className="tabular-nums">
                              {v.currentPercent}% / {v.requiredPercent}%
                            </span>
                            {absenceNote(v) && (
                              <span> · {absenceNote(v)}</span>
                            )}
                          </div>
                        ))}
                        {s.video.exempt.map((v) => (
                          <div key={v.id} className="text-[11px] text-muted-foreground">
                            <span>{v.titleAr || v.title}</span>
                            {" — "}
                            {tr("teacher.readiness.exempt")}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-border/60 p-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <Trophy className="w-3.5 h-3.5 text-muted-foreground" />
                      {tr("teacher.readiness.quiz")}
                      {!s.quiz.required && (
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {tr("course.224")}
                        </span>
                      )}
                    </div>
                    {s.quiz.required && (
                      <div className="mt-1">
                        {s.quiz.done ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {tr("teacher.readiness.ready")}
                          </span>
                        ) : (
                          <div className="space-y-0.5">
                            {s.quiz.pending.map((q) => (
                              <div key={q.id} className="text-[11px] text-muted-foreground">
                                {q.titleAr || q.title}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-border/60 p-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <ClipboardList className="w-3.5 h-3.5 text-muted-foreground" />
                      {tr("teacher.readiness.homework")}
                      {!s.homework.required && (
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {tr("course.224")}
                        </span>
                      )}
                    </div>
                    {s.homework.required && (
                      <div className="mt-1">
                        {s.homework.done ? (
                          <span className="inline-flex items-center gap-1 text-[11px] text-primary">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {tr("teacher.readiness.ready")}
                          </span>
                        ) : (
                          <div className="space-y-0.5">
                            {s.homework.pending.map((h) => (
                              <div key={h.id} className="text-[11px] text-muted-foreground">
                                {h.titleAr || h.title}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
