// CodeMind Academy — Phase F: the ADMIN live-session and absence console.
//
// The view is `admin-live-sessions`. Four tabs, one screen, one set of
// server authorities:
//
//   1. SESSIONS  — the operational list with filters (group / teacher / status
//                  / date / search), the review state of each register, and
//                  the admin-only ACTIONS: schedule, cancel, reschedule,
//                  substitute teacher (session-scoped, never a group transfer).
//   2. REVIEW    — the registers that need attention: unfinalized after the
//                  class, finalized with unmarked students
//                  (ATTENDANCE_INCOMPLETE) and teacher no-shows. Nothing here
//                  ever converts an unmarked student into an absence.
//   3. ABSENCES  — the review queue with the operational filters, the reason
//                  and its author, the decision (EXCUSE / UNEXCUSE with a
//                  mandatory-ish note), and the row-level CORRECTION of a
//                  locked register with a MANDATORY reason.
//   4. FLAGS     — the repeated-absence signal: factual counts only, explicitly
//                  non-punitive in the copy.
//
// Every dialog is height-bounded and scrolls internally (bug-T lesson), every
// destructive action confirms, and every failed action surfaces the server's
// own code so an admin is never left guessing.

"use client";

import * as React from "react";
import { useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { fmtDateTime as formatDateTime, type Locale } from "@/lib/i18n-core";
import { useJson, sendJson } from "@/lib/use-json";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EntitySelect, type EntityOption } from "@/components/shared/entity-select";
import {
  sessionDisplayOverride,
  sessionLessonIdentity,
} from "@/lib/live-session-policy";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
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
import { toast } from "sonner";
import { AlertTriangle, CalendarPlus, RefreshCw, ShieldAlert, UserCog, Wrench } from "lucide-react";

type SessionRow = {
  id: string;
  title: string;
  titleAr: string;
  startAt: string;
  endsAt: string;
  duration: number;
  status: string;
  reviewState: string;
  joined?: never;
  joinAllowed: boolean;
  joinDenialCode: string | null;
  joinOpensAt: string;
  joinClosesAt: string;
  attendanceLocked: boolean;
  attendanceFinalizedAt: string | null;
  rescheduleCount: number;
  group: { id: string; name: string } | null;
  lesson: { id: string; title: string; titleAr: string; officialCode?: string | null } | null;
  teacher: { id: string; name: string } | null;
  substituteTeacher: { id: string; name: string } | null;
  counts: { total: number; marked: number; unmarked: number; present: number; late: number; absent: number; excused: number };
};

type AbsenceCase = {
  id: string;
  status: string;
  reason: string | null;
  reasonSubmittedAt: string | null;
  reasonSubmittedByRole: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  student: { id: string; name: string; studentCode: string | null };
  session: { id: string; title: string; titleAr: string; startAt: string };
  lesson: { id: string; title: string; titleAr: string; officialCode?: string | null } | null;
  group: { id: string; name: string } | null;
  teacherName: string | null;
  hold: { status: string } | null;
  submissions: Array<{ id: string; reason: string; role: string; at: string; byName: string | null }>;
  flags: { repeatedAbsence: boolean; recentAbsentCount: number; threshold: number };
};

type OpsResponse = {
  overview: {
    today: { total: number; live: number; upcoming: number };
    upcoming: number;
    notFinalized: number;
    attendanceIncomplete: number;
    teacherNoShow: number;
    absencesPending: number;
    cancelled: number;
    rescheduled: number;
    repeatedAbsenceFlags: Array<{ studentId: string; studentName: string; count: number; threshold: number }>;
  };
  sessions: SessionRow[];
  needsReview: SessionRow[];
  pendingAbsences: AbsenceCase[];
};

function statusKey(status: string): string {
  switch (status) {
    case "SCHEDULED":
      return "live.status.scheduled";
    case "LIVE":
      return "live.status.live";
    case "COMPLETED":
      return "live.status.ended";
    case "CANCELLED":
      return "live.status.cancelled";
    default:
      return "live.status.unknown";
  }
}

function reviewKey(state: string): string {
  switch (state) {
    case "ATTENDANCE_OPEN":
      return "live.review.open";
    case "AWAITING_TEACHER":
      return "live.review.awaitingTeacher";
    case "ATTENDANCE_INCOMPLETE":
      return "live.review.incomplete";
    case "TEACHER_NO_SHOW":
      return "live.review.noShow";
    case "FINALIZED":
      return "live.review.finalized";
    default:
      return "live.review.notDue";
  }
}

function absenceStatusKey(status: string): string {
  switch (status) {
    case "PENDING_REASON":
      return "absence.status.pendingReason";
    case "PENDING_REVIEW":
      return "absence.status.pendingReview";
    case "EXCUSED":
      return "absence.status.excused";
    case "UNEXCUSED":
      return "absence.status.unexcused";
    case "NO_ACTION_REQUIRED":
      return "absence.status.noAction";
    default:
      return "absence.status.unknown";
  }
}

export function AdminLiveOpsView() {
  const t = useT();
  const locale = useApp((s) => (s.locale === "en" ? "en" : "ar")) as Locale;
  const fmt = (value: string | null) => (value ? formatDateTime(value, locale) : "");

  const [tab, setTab] = React.useState<"sessions" | "review" | "absences" | "flags">("sessions");
  const [filters, setFilters] = React.useState({ from: "", to: "", groupId: "", teacherId: "", status: "", q: "" });
  // Finding 1 — the teacher/group filters are SELECTORS over the authoritative
  // admin lists (the screen can never invent an id), while the query sent to
  // /api/admin/live-ops keeps exactly the same `groupId` / `teacherId` params.
  const filterGroups = useJson<{ groups: Array<{ id: string; name: string; courseName?: string | null; studentsCount?: number }> }>("/api/admin/groups");
  const filterTeachers = useJson<{ teachers: Array<{ id: string; name: string; email?: string | null; groupsCount?: number }> }>("/api/admin/teachers");
  const groupOptions: EntityOption[] = React.useMemo(
    () =>
      (filterGroups.data?.groups ?? []).map((g) => ({
        value: g.id,
        label: g.name,
        hint: g.courseName || undefined,
        meta: typeof g.studentsCount === "number" ? t("live.filter.optionCount", { p1: g.studentsCount }) : undefined,
      })),
    [filterGroups.data, t]
  );
  const teacherOptions: EntityOption[] = React.useMemo(
    () =>
      (filterTeachers.data?.teachers ?? []).map((row) => ({
        value: row.id,
        label: row.name,
        hint: row.email || undefined,
        meta: typeof row.groupsCount === "number" ? t("live.filter.groupsCount", { p1: row.groupsCount }) : undefined,
      })),
    [filterTeachers.data, t]
  );
  const [absenceStatus, setAbsenceStatus] = React.useState("PENDING_REVIEW");

  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (filters.from) params.set("from", new Date(filters.from).toISOString());
    if (filters.to) params.set("to", new Date(filters.to).toISOString());
    if (filters.groupId) params.set("groupId", filters.groupId);
    if (filters.teacherId) params.set("teacherId", filters.teacherId);
    if (filters.status) params.set("status", filters.status);
    if (filters.q) params.set("q", filters.q);
    params.set("absenceStatus", absenceStatus);
    return `/api/admin/live-ops?${params.toString()}`;
  }, [filters, absenceStatus]);

  const { data, loading, error, reload } = useJson<OpsResponse>(query);
  const [correctFor, setCorrectFor] = React.useState<{ session: SessionRow } | null>(null);
  const [substituteFor, setSubstituteFor] = React.useState<SessionRow | null>(null);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [rescheduleFor, setRescheduleFor] = React.useState<SessionRow | null>(null);

  const overview = data?.overview;

  const kpis: Array<{ key: string; value: number; tone?: string }> = [
    { key: "admin.live.kpi.today", value: overview?.today.total ?? 0 },
    { key: "admin.live.kpi.upcoming", value: overview?.upcoming ?? 0 },
    { key: "admin.live.kpi.notFinalized", value: overview?.notFinalized ?? 0 },
    { key: "admin.live.kpi.incomplete", value: overview?.attendanceIncomplete ?? 0 },
    { key: "admin.live.kpi.noShow", value: overview?.teacherNoShow ?? 0 },
    { key: "admin.live.kpi.pendingAbsences", value: overview?.absencesPending ?? 0 },
    { key: "admin.live.kpi.cancelled", value: overview?.cancelled ?? 0 },
    { key: "admin.live.kpi.rescheduled", value: overview?.rescheduled ?? 0 },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-lg font-bold">{t("admin.live.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("admin.live.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="w-4 h-4 ms-1.5" />
            {t("live.retry")}
          </Button>
          <Button size="sm" onClick={() => setScheduleOpen(true)}>
            <CalendarPlus className="w-4 h-4 ms-1.5" />
            {t("teacher.live.new")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        {kpis.map((kpi) => (
          <Card key={kpi.key} className="glass">
            <CardContent className="p-3">
              <p className="text-[11px] text-muted-foreground leading-tight">{t(kpi.key)}</p>
              <p className="text-xl font-bold mt-1">{kpi.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex gap-1 rounded-lg border p-1 flex-wrap">
        {(
          [
            ["sessions", "admin.live.tab.sessions"],
            ["review", "admin.live.tab.review"],
            ["absences", "admin.live.tab.absences"],
            ["flags", "admin.live.tab.flags"],
          ] as const
        ).map(([key, label]) => (
          <Button
            key={key}
            size="sm"
            variant={tab === key ? "default" : "ghost"}
            onClick={() => setTab(key)}
          >
            {t(label)}
          </Button>
        ))}
      </div>

      {loading ? (
        <Skeleton className="h-96" />
      ) : error ? (
        <Card>
          <CardContent className="py-10 flex flex-col items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-destructive" />
            <p className="text-sm">{t("live.loadError")}</p>
            <Button size="sm" variant="outline" onClick={reload}>
              {t("live.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : !data ? null : tab === "sessions" ? (
        <Card className="glass">
          <CardContent className="p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-2">
              <div>
                <Label className="text-[11px]">{t("admin.live.filterFrom")}</Label>
                <Input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
              </div>
              <div>
                <Label className="text-[11px]">{t("admin.live.filterTo")}</Label>
                <Input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
              </div>
              <div>
                <Label className="text-[11px]">{t("admin.live.filterGroup")}</Label>
                <EntitySelect
                  value={filters.groupId}
                  onChange={(groupId) => setFilters({ ...filters, groupId })}
                  options={groupOptions}
                  placeholder={t("live.filter.allGroups")}
                  searchPlaceholder={t("live.filter.searchGroups")}
                  allLabel={t("live.filter.allGroups")}
                  emptyLabel={t("live.filter.noGroups")}
                  loading={filterGroups.loading}
                  error={filterGroups.error ? t("live.loadError") : null}
                  onRetry={filterGroups.reload}
                />
              </div>
              <div>
                <Label className="text-[11px]">{t("admin.live.filterTeacher")}</Label>
                <EntitySelect
                  value={filters.teacherId}
                  onChange={(teacherId) => setFilters({ ...filters, teacherId })}
                  options={teacherOptions}
                  placeholder={t("live.filter.allTeachers")}
                  searchPlaceholder={t("live.filter.searchTeachers")}
                  allLabel={t("live.filter.allTeachers")}
                  emptyLabel={t("live.filter.noTeachers")}
                  loading={filterTeachers.loading}
                  error={filterTeachers.error ? t("live.loadError") : null}
                  onRetry={filterTeachers.reload}
                />
              </div>
              <div>
                <Label className="text-[11px]">{t("admin.live.filterStatus")}</Label>
                <Select value={filters.status || "ALL"} onValueChange={(v) => setFilters({ ...filters, status: v === "ALL" ? "" : v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t("admin.live.filterAll")}</SelectItem>
                    <SelectItem value="SCHEDULED">{t("live.status.scheduled")}</SelectItem>
                    <SelectItem value="LIVE">{t("live.status.live")}</SelectItem>
                    <SelectItem value="COMPLETED">{t("live.status.ended")}</SelectItem>
                    <SelectItem value="CANCELLED">{t("live.status.cancelled")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[11px]">{t("teacher.live.search")}</Label>
                <Input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
              </div>
            </div>

            {/* Bug-T rule: the table scrolls inside a bounded box, so the page
                (and the dialogs above it) never clips the last row. */}
            <ScrollArea className="min-h-0" viewportClassName="max-h-[min(56dvh,calc(100dvh-24rem))] min-h-0 overscroll-contain">
              <div className="pb-1 pe-1">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("live.title")}</TableHead>
                      <TableHead>{t("live.startAt")}</TableHead>
                      <TableHead>{t("admin.live.filterGroup")}</TableHead>
                      <TableHead>{t("admin.live.filterTeacher")}</TableHead>
                      <TableHead>{t("admin.live.filterStatus")}</TableHead>
                      <TableHead>{t("teacher.live.attendance")}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.sessions.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                          {t("admin.live.empty")}
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.sessions.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell className="max-w-56">
                            {/* Finding 2 — the academic identity is the linked
                                LESSON (`1-1 — <title>`); the free-text session
                                title, when it adds something, is a secondary
                                display override. A legacy row without a lesson
                                stays readable and is marked as unlinked. */}
                            {sessionLessonIdentity(s.lesson, locale) ? (
                              <>
                                <div className="font-medium truncate">
                                  {sessionLessonIdentity(s.lesson, locale)}
                                </div>
                                {sessionDisplayOverride(s.titleAr || s.title, s.lesson, locale) ? (
                                  <div className="text-[11px] text-muted-foreground truncate">
                                    {sessionDisplayOverride(s.titleAr || s.title, s.lesson, locale)}
                                  </div>
                                ) : null}
                              </>
                            ) : (
                              <>
                                <div className="font-medium truncate">{s.titleAr || s.title}</div>
                                <div className="text-[11px] text-muted-foreground truncate">
                                  {t("live.lesson.unlinked")}
                                </div>
                              </>
                            )}
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{fmt(s.startAt)}</TableCell>
                          <TableCell className="text-xs">{s.group?.name ?? "—"}</TableCell>
                          <TableCell className="text-xs">
                            {s.substituteTeacher ? `${s.substituteTeacher.name} (${t("admin.live.substitute")})` : s.teacher?.name ?? "—"}
                          </TableCell>
                          <TableCell>
                            <Badge variant={s.status === "CANCELLED" ? "destructive" : s.status === "LIVE" ? "default" : "outline"}>
                              {t(statusKey(s.status))}
                            </Badge>
                            <div className="text-[10px] text-muted-foreground mt-1">{t(reviewKey(s.reviewState))}</div>
                          </TableCell>
                          <TableCell className="text-xs">
                            {s.attendanceLocked
                              ? `${s.counts.marked} / ${s.counts.total}`
                              : s.counts.unmarked === s.counts.total
                                ? t("live.review.awaitingTeacher")
                                : `${s.counts.marked} / ${s.counts.total}`}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1 justify-end flex-wrap">
                              {s.attendanceLocked && (
                                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setCorrectFor({ session: s })}>
                                  <Wrench className="w-3.5 h-3.5 ms-1" />
                                  {t("admin.live.correct")}
                                </Button>
                              )}
                              {s.status !== "CANCELLED" && s.status !== "COMPLETED" && (
                                <>
                                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setRescheduleFor(s)}>
                                    {t("teacher.live.reschedule")}
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSubstituteFor(s)}>
                                    <UserCog className="w-3.5 h-3.5 ms-1" />
                                    {t("admin.live.substitute")}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-xs text-destructive"
                                    onClick={async () => {
                                      const result = await sendJson(`/api/live-sessions/${s.id}/cancel`, "POST", { reason: null });
                                      if (!result.ok) {
                                        toast.error(String(result.body?.error ?? t("live.loadError")));
                                        return;
                                      }
                                      toast.success(t("teacher.live.cancelled"));
                                      reload();
                                    }}
                                  >
                                    {t("teacher.live.cancel")}
                                  </Button>
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      ) : tab === "review" ? (
        <Card className="glass">
          <CardContent className="p-4 space-y-2">
            <p className="text-xs text-muted-foreground">{t("admin.live.lockedNotice")}</p>
            {data.needsReview.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">{t("admin.live.empty")}</p>
            ) : (
              <ul className="space-y-2">
                {data.needsReview.map((s) => (
                  <li key={s.id} className="rounded-lg border p-3 flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{s.titleAr || s.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {fmt(s.startAt)} • {s.group?.name ?? "—"} • {s.teacher?.name ?? "—"}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {t("teacher.live.completion", { p1: s.counts.marked, p2: s.counts.total })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={s.reviewState === "TEACHER_NO_SHOW" ? "destructive" : "secondary"}>
                        <ShieldAlert className="w-3 h-3 me-1" />
                        {t(reviewKey(s.reviewState))}
                      </Badge>
                      {s.attendanceLocked && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setCorrectFor({ session: s })}>
                          {t("admin.live.correct")}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : tab === "absences" ? (
        <Card className="glass">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-[11px]">{t("admin.live.filterStatus")}</Label>
              <Select value={absenceStatus} onValueChange={setAbsenceStatus}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("admin.live.filterAll")}</SelectItem>
                  <SelectItem value="PENDING_REASON">{t("absence.status.pendingReason")}</SelectItem>
                  <SelectItem value="PENDING_REVIEW">{t("absence.status.pendingReview")}</SelectItem>
                  <SelectItem value="EXCUSED">{t("absence.status.excused")}</SelectItem>
                  <SelectItem value="UNEXCUSED">{t("absence.status.unexcused")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {data.pendingAbsences.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">{t("admin.live.empty")}</p>
            ) : (
              <ScrollArea className="min-h-0" viewportClassName="max-h-[min(56dvh,calc(100dvh-26rem))] min-h-0 overscroll-contain">
                <ul className="pb-1 pe-1 space-y-2">
                  {data.pendingAbsences.map((item) => (
                    <AbsenceReviewRow
                      key={item.id}
                      item={item}
                      onDone={reload}
                      onCorrect={() => {
                        const match = data.sessions.find((s) => s.id === item.session.id);
                        if (match) setCorrectFor({ session: match });
                        else toast.info(t("admin.live.correctTitle"));
                      }}
                    />
                  ))}
                </ul>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card className="glass">
          <CardContent className="p-4 space-y-3">
            <p className="text-xs text-muted-foreground">{t("admin.live.repeatedAbsenceHint")}</p>
            {(overview?.repeatedAbsenceFlags ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">{t("admin.live.empty")}</p>
            ) : (
              <ul className="space-y-2">
                {(overview?.repeatedAbsenceFlags ?? []).map((flag) => (
                  <li key={flag.studentId} className="rounded-lg border p-3 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{flag.studentName || flag.studentId}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("admin.live.absentCount", { p1: flag.count })} • {t("admin.live.repeatedAbsence", { p1: 30 })}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <CorrectionDialog
        open={Boolean(correctFor)}
        onOpenChange={(v) => setCorrectFor(v ? correctFor : null)}
        session={correctFor?.session ?? null}
        onDone={reload}
        onNeedRoster={(session) => session}
      />

      <SubstituteDialog
        open={Boolean(substituteFor)}
        onOpenChange={(v) => setSubstituteFor(v ? substituteFor : null)}
        session={substituteFor}
        onDone={reload}
      />

      <RescheduleDialog
        open={Boolean(rescheduleFor)}
        onOpenChange={(v) => setRescheduleFor(v ? rescheduleFor : null)}
        session={rescheduleFor}
        onDone={reload}
      />

      <AdminScheduleDialog open={scheduleOpen} onOpenChange={setScheduleOpen} onCreated={reload} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Absence review row
// ---------------------------------------------------------------------------

function AbsenceReviewRow({
  item,
  onDone,
  onCorrect,
}: {
  item: AbsenceCase;
  onDone: () => void;
  onCorrect: () => void;
}) {
  const t = useT();
  const locale = useApp((s) => (s.locale === "en" ? "en" : "ar")) as Locale;
  const fmt = (value: string | null) => (value ? formatDateTime(value, locale) : "");

  const [open, setOpen] = React.useState<null | "EXCUSE" | "UNEXCUSE">(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const decided = item.status === "EXCUSED" || item.status === "UNEXCUSED" || item.status === "NO_ACTION_REQUIRED";

  const decide = async () => {
    if (!open) return;
    setBusy(true);
    const result = await sendJson(`/api/absence-reviews/${item.id}/decision`, "POST", {
      decision: open,
      note: note.trim() || null,
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(String(result.body?.error ?? t("live.loadError")));
      return;
    }
    toast.success(t("admin.live.decided"));
    setOpen(null);
    setNote("");
    onDone();
  };

  return (
    <li className="rounded-lg border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {item.student.name}
            {item.student.studentCode ? ` • ${item.student.studentCode}` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {/* Finding 2 — canonical lesson identity first (`1-1 — <title>`),
                then the session's own display title when it differs. */}
            {sessionLessonIdentity(item.lesson, locale) ??
              sessionDisplayOverride(item.session.titleAr || item.session.title, item.lesson, locale) ??
              (item.session.titleAr || item.session.title)}{" "}
            • {fmt(item.session.startAt)}
            {item.group ? ` • ${item.group.name}` : ""}
            {item.teacherName ? ` • ${item.teacherName}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-wrap">
          {item.flags.repeatedAbsence && (
            <Badge variant="outline" className="text-[10px]">
              {t("admin.live.repeatedAbsence", { p1: 30 })}
            </Badge>
          )}
          {item.hold && (
            <Badge variant={item.hold.status === "ACTIVE" ? "destructive" : "secondary"} className="text-[10px]">
              {t("admin.live.hold")}: {item.hold.status === "ACTIVE" ? t("absence.hold.active") : t("absence.hold.resolved")}
            </Badge>
          )}
          <Badge variant={item.status === "EXCUSED" ? "secondary" : item.status === "UNEXCUSED" ? "destructive" : "outline"}>
            {t(absenceStatusKey(item.status))}
          </Badge>
        </div>
      </div>

      <div className="rounded-md border bg-muted/30 p-2">
        <p className="text-[11px] font-semibold">{t("admin.live.reason")}</p>
        <p className="text-xs break-words">{item.reason ?? t("admin.live.noReason")}</p>
        {item.reasonSubmittedAt && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {t("admin.live.submittedBy")}: {item.reasonSubmittedByRole} • {fmt(item.reasonSubmittedAt)}
          </p>
        )}
      </div>

      {item.submissions.length > 1 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">{t("student.absences.history")}</summary>
          <ul className="mt-1 space-y-0.5">
            {item.submissions.map((s) => (
              <li key={s.id} className="text-muted-foreground">
                {fmt(s.at)} — {s.byName ?? s.role}: {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {item.decisionNote && <p className="text-[11px] text-muted-foreground">{item.decisionNote}</p>}

      <div className="flex gap-2 flex-wrap">
        {!decided && (
          <>
            <Button size="sm" variant="default" className="h-7 px-2 text-xs" onClick={() => setOpen("EXCUSE")}>
              {t("admin.live.decideExcuse")}
            </Button>
            <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={() => setOpen("UNEXCUSE")}>
              {t("admin.live.decideUnexcuse")}
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onCorrect}>
          <Wrench className="w-3.5 h-3.5 ms-1" />
          {t("admin.live.correct")}
        </Button>
      </div>

      <Dialog open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {open === "EXCUSE" ? t("admin.live.decideExcuse") : t("admin.live.decideUnexcuse")}
            </DialogTitle>
            <DialogDescription>{item.student.name}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2 py-2">
            <Label htmlFor={`note-${item.id}`}>{t("admin.live.decideNote")}</Label>
            <Textarea id={`note-${item.id}`} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(null)}>
              {t("plan.018")}
            </Button>
            <Button variant={open === "UNEXCUSE" ? "destructive" : "default"} onClick={decide} disabled={busy}>
              {open === "EXCUSE" ? t("admin.live.decideExcuse") : t("admin.live.decideUnexcuse")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Correction of a locked register (admin only, mandatory reason)
// ---------------------------------------------------------------------------

function CorrectionDialog({
  open,
  onOpenChange,
  session,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session: SessionRow | null;
  onDone: () => void;
  onNeedRoster?: (session: SessionRow) => SessionRow;
}) {
  const t = useT();
  const roster = useJson<{ roster: Array<{ studentId: string; name: string; status: string }> }>(
    open && session ? `/api/live-sessions/${session.id}/attendance` : null
  );
  const [studentId, setStudentId] = React.useState("");
  const [status, setStatus] = React.useState("PRESENT");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setStudentId("");
      setStatus("PRESENT");
      setReason("");
    }
  }, [open]);

  const submit = async () => {
    if (!session) return;
    if (reason.trim().length < 3) {
      toast.error(t("admin.live.correctionReasonHint"));
      return;
    }
    setBusy(true);
    const result = await sendJson(`/api/live-sessions/${session.id}/attendance/correction`, "POST", {
      studentId,
      newStatus: status,
      reason: reason.trim(),
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(String(result.body?.error ?? t("live.loadError")));
      return;
    }
    toast.success(t("admin.live.correctDone"));
    onOpenChange(false);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("admin.live.correctTitle")}</DialogTitle>
          <DialogDescription>
            {session ? `${session.titleAr || session.title} • ${session.group?.name ?? ""}` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 py-2">
          <div>
            <Label>{t("teacher.live.students")}</Label>
            <Select value={studentId} onValueChange={setStudentId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("live.attendance.unmarked")} />
              </SelectTrigger>
              <SelectContent>
                {(roster.data?.roster ?? []).map((row) => (
                  <SelectItem key={row.studentId} value={row.studentId}>
                    {row.name} — {row.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("admin.live.filterStatus")}</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PRESENT">{t("live.attendance.present")}</SelectItem>
                <SelectItem value="LATE">{t("live.attendance.late")}</SelectItem>
                <SelectItem value="ABSENT">{t("live.attendance.absent")}</SelectItem>
                <SelectItem value="EXCUSED">{t("live.attendance.excused")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="correction-reason">{t("admin.live.correctReason")}</Label>
            <Textarea
              id="correction-reason"
              rows={3}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground mt-1">{t("admin.live.correctionReasonHint")}</p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("plan.018")}
          </Button>
          <Button onClick={submit} disabled={busy || !studentId || reason.trim().length < 3}>
            {t("admin.live.correct")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Substitute teacher (session-scoped)
// ---------------------------------------------------------------------------

function SubstituteDialog({
  open,
  onOpenChange,
  session,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session: SessionRow | null;
  onDone: () => void;
}) {
  const t = useT();
  const [teacherId, setTeacherId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const teachers = useJson<{ teachers: Array<{ id: string; user?: { name: string }; name?: string }> }>(
    open ? "/api/admin/teachers" : null
  );

  React.useEffect(() => {
    if (open) setTeacherId("");
  }, [open]);

  const submit = async () => {
    if (!session || !teacherId) return;
    setBusy(true);
    const result = await sendJson(`/api/live-sessions/${session.id}/substitute`, "POST", {
      substituteTeacherId: teacherId,
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(String(result.body?.error ?? t("live.loadError")));
      return;
    }
    toast.success(t("admin.live.substituteDone"));
    onOpenChange(false);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("admin.live.substitute")}</DialogTitle>
          <DialogDescription>{t("admin.live.substituteHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2 py-2">
          <Label>{t("admin.live.filterTeacher")}</Label>
          <Select value={teacherId} onValueChange={setTeacherId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("admin.live.filterTeacher")} />
            </SelectTrigger>
            <SelectContent>
              {(teachers.data?.teachers ?? []).map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.user?.name ?? row.name ?? row.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("plan.018")}
          </Button>
          <Button
            onClick={submit}
            disabled={busy || !teacherId}
          >
            {t("admin.live.substitute")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reschedule (admin)
// ---------------------------------------------------------------------------

function RescheduleDialog({
  open,
  onOpenChange,
  session,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session: SessionRow | null;
  onDone: () => void;
}) {
  const t = useT();
  const [startAt, setStartAt] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open && session) {
      const d = new Date(session.startAt);
      const pad = (n: number) => String(n).padStart(2, "0");
      setStartAt(
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      );
      setReason("");
    }
  }, [open, session]);

  const submit = async () => {
    if (!session) return;
    setBusy(true);
    const result = await sendJson(`/api/live-sessions/${session.id}/reschedule`, "POST", {
      startAt: new Date(startAt).toISOString(),
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(String(result.body?.error ?? t("live.loadError")));
      return;
    }
    toast.success(t("teacher.live.rescheduled"));
    onOpenChange(false);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("teacher.live.reschedule")}</DialogTitle>
          <DialogDescription>{session?.titleAr || session?.title || ""}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 py-2">
          <div>
            <Label htmlFor="admin-reschedule-start">{t("teacher.live.rescheduleNewStart")}</Label>
            <Input id="admin-reschedule-start" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="admin-reschedule-reason">{t("teacher.live.rescheduleReason")}</Label>
            <Textarea id="admin-reschedule-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("plan.018")}
          </Button>
          <Button onClick={submit} disabled={busy || !startAt}>
            {t("teacher.live.reschedule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Schedule (admin) — group + lesson + time + link
// ---------------------------------------------------------------------------

function AdminScheduleDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const t = useT();
  const locale = useApp((s) => (s.locale === "en" ? "en" : "ar")) as Locale;
  // Finding 2 — the group is chosen from the authoritative list and carries its
  // COURSE, which is what constrains the selectable Lessons below.
  const groups = useJson<{ groups: Array<{ id: string; name: string; courseId: string; courseName?: string | null }> }>(open ? "/api/admin/groups" : null);
  const [groupId, setGroupId] = React.useState("");
  const [lessonId, setLessonId] = React.useState("");
  const [teacherId, setTeacherId] = React.useState("");
  const [titleAr, setTitleAr] = React.useState("");
  const [startAt, setStartAt] = React.useState("");
  const [duration, setDuration] = React.useState("120");
  const [meetingUrl, setMeetingUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const teachers = useJson<{ teachers: Array<{ id: string; user?: { name: string }; name?: string }> }>(
    open ? "/api/admin/teachers" : null
  );

  // The group's course constrains the lessons: only a Lesson that really
  // belongs to this course can be scheduled (the server re-validates it).
  const selectedGroupCourseId = React.useMemo(
    () => (groups.data?.groups ?? []).find((g) => g.id === groupId)?.courseId ?? null,
    [groups.data, groupId]
  );
  const lessons = useJson<{ lessons: Array<{ id: string; officialCode?: string | null; title: string; titleAr: string }> }>(
    open && selectedGroupCourseId ? `/api/admin/lessons?courseId=${selectedGroupCourseId}&limit=200` : null
  );
  const lessonOptions: EntityOption[] = React.useMemo(
    () =>
      (lessons.data?.lessons ?? []).map((l) => ({
        value: l.id,
        label:
          sessionLessonIdentity(
            { officialCode: l.officialCode ?? null, title: l.title, titleAr: l.titleAr },
            locale
          ) ?? l.id,
      })),
    [lessons.data, locale]
  );
  const selectedLessonLabel = React.useMemo(
    () => lessonOptions.find((o) => o.value === lessonId)?.label ?? "",
    [lessonOptions, lessonId]
  );

  // A group change invalidates the lesson: scheduling "group A + lesson from
  // another course" must be impossible from the UI as well as from the API.
  React.useEffect(() => {
    setLessonId("");
  }, [groupId]);

  React.useEffect(() => {
    if (open && !startAt) {
      const d = new Date(Date.now() + 60 * 60 * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      setStartAt(
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
      );
    }
  }, [open, startAt]);

  const submit = async () => {
    // Finding 2 — a session MUST be scheduled against a real Lesson: that is
    // its academic identity (and what Phase H progression/catch-up will read).
    // The free-text title is optional and only overrides the DISPLAY name.
    if (!groupId || !lessonId || !startAt) {
      toast.error(!lessonId ? t("live.lesson.pick") : t("live.lesson.pick"));
      return;
    }
    setBusy(true);
    const result = await sendJson("/api/live-sessions", "POST", {
      groupId,
      lessonId,
      teacherId: teacherId || null,
      // Empty title → the server derives it from the lesson (no free text
      // standing in for the academic identity).
      title: titleAr.trim() || null,
      titleAr: titleAr.trim() || null,
      startAt: new Date(startAt).toISOString(),
      duration: Number(duration),
      meetingUrl: meetingUrl.trim() || null,
    });
    setBusy(false);
    if (!result.ok) {
      if (String(result.body?.code) === "INVALID_MEETING_URL") toast.error(t("teacher.live.meetingUrlHint"));
      else toast.error(String(result.body?.error ?? t("live.loadError")));
      return;
    }
    toast.success(t("teacher.live.scheduleSaved"));
    onOpenChange(false);
    setLessonId("");
    setTitleAr("");
    setMeetingUrl("");
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("teacher.live.schedule")}</DialogTitle>
          <DialogDescription>{t("admin.live.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 py-2">
          <div>
            <Label>{t("admin.live.filterGroup")}</Label>
            <EntitySelect
              value={groupId}
              onChange={setGroupId}
              options={(groups.data?.groups ?? []).map((g) => ({
                value: g.id,
                label: g.name,
                hint: g.courseName || undefined,
              }))}
              placeholder={t("admin.live.filterGroup")}
              searchPlaceholder={t("live.filter.searchGroups")}
              allLabel={t("live.filter.allGroups")}
              emptyLabel={t("live.filter.noGroups")}
              loading={groups.loading}
              error={groups.error ? t("live.loadError") : null}
              onRetry={groups.reload}
            />
          </div>
          <div>
            <Label>{t("admin.live.filterTeacher")}</Label>
            <Select value={teacherId} onValueChange={setTeacherId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("admin.live.filterTeacher")} />
              </SelectTrigger>
              <SelectContent>
                {(teachers.data?.teachers ?? []).map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.user?.name ?? row.name ?? row.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("live.lesson")}</Label>
            {/* Finding 2 — the group's COURSE constrains this list, and the
                option text is the canonical `1-1 — <title>` identity. */}
            <EntitySelect
              value={lessonId}
              onChange={setLessonId}
              options={lessonOptions}
              placeholder={t("live.lesson.pick")}
              searchPlaceholder={t("live.filter.searchGroups")}
              allLabel={t("live.lesson.pick")}
              emptyLabel={
                selectedGroupCourseId ? t("live.lesson.none") : t("admin.live.filterGroup")
              }
              loading={Boolean(selectedGroupCourseId) && lessons.loading}
              error={lessons.error ? t("live.lesson.loadError") : null}
              onRetry={lessons.reload}
              disabled={!selectedGroupCourseId}
            />
            {lessonId ? (
              <div className="text-[11px] text-emerald-600 mt-1 truncate">{selectedLessonLabel}</div>
            ) : null}
          </div>
          <div>
            <Label htmlFor="admin-schedule-title">{t("live.lesson.optionalTitle")}</Label>
            <Input
              id="admin-schedule-title"
              value={titleAr}
              maxLength={200}
              placeholder={selectedLessonLabel}
              onChange={(e) => setTitleAr(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground mt-1">{t("live.lesson.optionalHint")}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="admin-schedule-start">{t("live.startAt")}</Label>
              <Input id="admin-schedule-start" type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="admin-schedule-duration">{t("live.durationLabel")}</Label>
              <Input
                id="admin-schedule-duration"
                type="number"
                min={15}
                max={600}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="admin-schedule-url">{t("teacher.live.meetingUrl")}</Label>
            <Input id="admin-schedule-url" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="https://…" />
            <p className="text-[11px] text-muted-foreground mt-1">{t("teacher.live.meetingUrlHint")}</p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("plan.018")}
          </Button>
          <Button onClick={submit} disabled={busy || !groupId || !lessonId || !startAt}>
            {t("live.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AdminLiveOpsView;
