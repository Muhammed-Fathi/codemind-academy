// CodeMind Academy — Phase F: the TEACHER live-session workspace.
//
// The view is `teacher-live-sessions`. It is the teacher's whole live day:
//
//   * schedule a session inside one of their OWN groups (the group list comes
//     from the server scope; the dialog cannot offer a foreign group), with an
//     optional lesson from the existing teacher lesson picker and the session
//     link validated by the server;
//   * see each session's state (scheduled / live / ended / cancelled, the
//     reschedule counter, the substitute badge, the attendance review state);
//   * start the live period, join or copy the link, reschedule or cancel;
//   * TAKE ATTENDANCE FAST: search, one Present/Late/Absent button per student,
//     an explicit "mark all present" that is a DRAFT until saved, an unsaved
//     indicator, the completion counter ("28 / 30 students marked"), and an
//     explicit finalize with a confirmation that names what the server will do;
//   * after finalization the register is READ-ONLY (the server refuses writes
//     and this screen stops offering them) and the teacher is told that only
//     an admin can correct it, with a recorded reason.
//
// UNMARKED ≠ ABSENT is visible in the UI: an unmarked student shows "لم يُسجَّل"
// and finalizing with unmarked students requires an explicit acknowledgement
// that says out loud that the session will be flagged for admin review rather
// than marking anyone absent.

"use client";

import * as React from "react";
import { useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { fmtDateTime as formatDateTime, type Locale } from "@/lib/i18n-core";
import { EntitySelect, type EntityOption } from "@/components/shared/entity-select";
import {
  sessionDisplayOverride,
  sessionLessonIdentity,
} from "@/lib/live-session-policy";
import { useJson, sendJson } from "@/lib/use-json";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { SessionLinkActions } from "@/components/shared/session-link-actions";
import { toast } from "sonner";
import { AlertTriangle, CalendarPlus, Check, Lock, Play, Search, X, Zap } from "lucide-react";

type SessionRow = {
  id: string;
  title: string;
  titleAr: string;
  startAt: string;
  endsAt: string;
  duration: number;
  status: string;
  phase: string;
  reviewState: string;
  joinAllowed: boolean;
  joinDenialCode: string | null;
  joinOpensAt: string;
  joinClosesAt: string;
  /** Finding 4 — the CONFIGURED join-before rule in minutes (one authority). */
  joinEarlyMinutes?: number;
  /** Finding 3 — the live/start window, decided by the server. */
  startAllowed?: boolean;
  startDenialCode?: string | null;
  startOpensAt?: string;
  attendanceLocked: boolean;
  attendanceFinalizedAt: string | null;
  rescheduleCount: number;
  group: { id: string; name: string; courseId: string } | null;
  lesson: { id: string; title: string; titleAr: string; officialCode?: string | null } | null;
  teacher: { id: string; name: string } | null;
  substituteTeacher: { id: string; name: string } | null;
  counts?: { total: number; marked: number; unmarked: number; present: number; late: number; absent: number; excused: number };
};

type RosterRow = {
  studentId: string;
  name: string;
  studentCode: string | null;
  status: "UNMARKED" | "PRESENT" | "LATE" | "ABSENT" | "EXCUSED";
  rawStatus: string | null;
  note: string | null;
  locked: boolean;
  overallPct: number | null;
  overallTotal: number;
};

type WorkspaceResponse = {
  session: SessionRow;
  roster: RosterRow[];
  counts: { total: number; marked: number; unmarked: number; present: number; late: number; absent: number; excused: number };
  finalizeHint: { unmarked: number; total: number };
  via?: string;
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

function attendanceKey(status: string): string {
  switch (status) {
    case "PRESENT":
      return "live.attendance.present";
    case "LATE":
      return "live.attendance.late";
    case "ABSENT":
      return "live.attendance.absent";
    case "EXCUSED":
      return "live.attendance.excused";
    default:
      return "live.attendance.unmarked";
  }
}

/** `datetime-local` value for a Date (local, no timezone surprises). */
function toLocalInput(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TeacherLiveSessionsWorkspace() {
  const t = useT();
  const locale = useApp((s) => (s.locale === "en" ? "en" : "ar")) as Locale;
  const fmt = (value: string | null) => (value ? formatDateTime(value, locale) : "");

  const list = useJson<{ sessions: SessionRow[]; groups: Array<{ id: string; name: string; courseId: string }> }>(
    "/api/live-sessions"
  );
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);

  const sessions = list.data?.sessions ?? [];
  const groups = list.data?.groups ?? [];

  React.useEffect(() => {
    if (!selectedId && sessions.length > 0) {
      // Default to the session a teacher most likely wants: the live one, else
      // the next upcoming, else the most recent.
      const live = sessions.find((s) => s.status === "LIVE");
      const upcoming = [...sessions]
        .filter((s) => new Date(s.startAt).getTime() >= Date.now() - 60 * 60 * 1000)
        .sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt))[0];
      setSelectedId(live?.id ?? upcoming?.id ?? sessions[0].id);
    }
  }, [sessions, selectedId]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-lg font-bold">{t("teacher.live.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("teacher.live.subtitle")}</p>
        </div>
        <Button onClick={() => setScheduleOpen(true)} disabled={groups.length === 0}>
          <CalendarPlus className="w-4 h-4 ms-1.5" />
          {t("teacher.live.new")}
        </Button>
      </div>

      {list.loading ? (
        <Skeleton className="h-72" />
      ) : list.error ? (
        <Card>
          <CardContent className="py-10 flex flex-col items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-destructive" />
            <p className="text-sm">{t("live.loadError")}</p>
            <Button size="sm" variant="outline" onClick={list.reload}>
              {t("live.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center space-y-2">
            <p className="text-sm font-semibold">{t("teacher.live.noSessions")}</p>
            <p className="text-xs text-muted-foreground">{t("live.emptyHint")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 items-start">
          <Card className="glass">
            <CardContent className="p-2">
              <ScrollArea className="min-h-0" viewportClassName="max-h-[min(60dvh,calc(100dvh-18rem))] overscroll-contain">
                <ul className="pb-1 space-y-1">
                  {sessions.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(s.id)}
                        className={`w-full text-start rounded-lg p-3 border transition-colors ${
                          selectedId === s.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted/60"
                        }`}
                        aria-current={selectedId === s.id}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold truncate">{s.titleAr || s.title}</span>
                          <Badge variant={s.status === "LIVE" ? "default" : s.status === "CANCELLED" ? "destructive" : "outline"}>
                            {t(statusKey(s.status))}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {fmt(s.startAt)} • {s.group?.name ?? ""}
                        </p>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </CardContent>
          </Card>

          {selectedId && (
            <SessionDetail
              key={selectedId}
              sessionId={selectedId}
              groups={groups}
              onChanged={list.reload}
            />
          )}
        </div>
      )}

      <ScheduleDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        groups={groups}
        onCreated={() => {
          list.reload();
          setSelectedId(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The per-session workspace
// ---------------------------------------------------------------------------

function SessionDetail({
  sessionId,
  groups,
  onChanged,
}: {
  sessionId: string;
  groups: Array<{ id: string; name: string; courseId: string }>;
  onChanged: () => void;
}) {
  const t = useT();
  const locale = useApp((s) => (s.locale === "en" ? "en" : "ar")) as Locale;
  const fmt = (value: string | null) => (value ? formatDateTime(value, locale) : "");

  const ws = useJson<WorkspaceResponse>(`/api/live-sessions/${sessionId}/attendance`);
  const [draft, setDraft] = React.useState<Record<string, RosterRow["status"]>>({});
  const [dirty, setDirty] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const [finalizeOpen, setFinalizeOpen] = React.useState(false);
  const [ackUnmarked, setAckUnmarked] = React.useState(false);
  const [rescheduleOpen, setRescheduleOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);

  const session = ws.data?.session ?? null;
  const roster = ws.data?.roster ?? [];
  const counts = ws.data?.counts;
  const locked = Boolean(session?.attendanceLocked);

  React.useEffect(() => {
    // A fresh payload resets the local draft (the server is the truth).
    setDraft({});
    setDirty(false);
  }, [ws.data]);

  const statusFor = (row: RosterRow): RosterRow["status"] => draft[row.studentId] ?? row.status;

  const draftCounts = React.useMemo(() => {
    const merged = roster.map((row) => ({ status: statusFor(row) }));
    const total = merged.length;
    const marked = merged.filter((r) => r.status !== "UNMARKED").length;
    return {
      total,
      marked,
      unmarked: total - marked,
      present: merged.filter((r) => r.status === "PRESENT").length,
      late: merged.filter((r) => r.status === "LATE").length,
      absent: merged.filter((r) => r.status === "ABSENT").length,
      excused: merged.filter((r) => r.status === "EXCUSED").length,
    };
  }, [roster, draft]);

  // Finding 5 — ONE place decides why finalizing is unavailable, and the same
  // answer drives both the disabled state and the visible explanation.
  // Order matters: unsaved changes first (they would be silently dropped
  // otherwise), then the unmarked acknowledgement.
  const finalizeBlockedReason: string | null = dirty
    ? "teacher.live.finalizeNeedsSave"
    : draftCounts.unmarked > 0 && !ackUnmarked
      ? "teacher.live.finalizeNeedsAck"
      : null;

  const filtered = roster.filter((row) =>
    search.trim() ? row.name.toLowerCase().includes(search.trim().toLowerCase()) : true
  );

  const setStatus = (studentId: string, status: RosterRow["status"]) => {
    if (locked) return;
    setDraft((prev) => ({ ...prev, [studentId]: status }));
    setDirty(true);
  };

  const save = async () => {
    const entries = Object.entries(draft).map(([studentId, status]) => ({ studentId, status }));
    if (entries.length === 0) {
      toast.info(t("teacher.live.saved"));
      return;
    }
    setBusy(true);
    const result = await sendJson(`/api/live-sessions/${sessionId}/attendance`, "POST", { attendance: entries });
    setBusy(false);
    if (!result.ok) {
      const code = String(result.body?.code ?? "");
      if (code === "ATTENDANCE_WINDOW_CLOSED") toast.error(t("teacher.live.windowClosed"));
      else if (code === "ATTENDANCE_ALREADY_FINALIZED") toast.error(t("teacher.live.locked"));
      else if (code === "ATTENDANCE_NOT_STARTED") toast.error(t("teacher.live.windowNotOpen"));
      else toast.error(String(result.body?.error ?? t("live.loadError")));
      return;
    }
    toast.success(t("teacher.live.saved"));
    setDirty(false);
    ws.reload();
  };

  const markAllPresent = () => {
    const next: Record<string, RosterRow["status"]> = { ...draft };
    for (const row of roster) next[row.studentId] = "PRESENT";
    setDraft(next);
    setDirty(true);
    toast.info(t("teacher.live.markAllPresentDone"));
  };

  const finalize = async () => {
    setBusy(true);
    const result = await sendJson(`/api/live-sessions/${sessionId}/attendance/finalize`, "POST", {
      acknowledgeUnmarked: ackUnmarked,
    });
    setBusy(false);
    if (!result.ok) {
      if (String(result.body?.code) === "UNMARKED_REMAIN") {
        toast.error(t("teacher.live.unmarkedWarn", { p1: result.body?.details?.unmarked ?? draftCounts.unmarked }));
        setFinalizeOpen(true);
        return;
      }
      toast.error(String(result.body?.error ?? t("live.loadError")));
      return;
    }
    toast.success(t("teacher.live.finalized"));
    setFinalizeOpen(false);
    setAckUnmarked(false);
    ws.reload();
    onChanged();
  };

  const lifecycle = async (action: "start" | "end") => {
    setBusy(true);
    const result = await sendJson(`/api/live-sessions/${sessionId}`, "PATCH", { action });
    setBusy(false);
    if (!result.ok) {
      // Finding 3 — the server is the authority: translate its refusal into
      // the same wording the disabled button shows, so UI and API agree.
      const code = String(result.body?.code ?? "");
      if (code === "SESSION_START_TOO_EARLY") {
        toast.error(t("teacher.live.startTooEarly", { p1: fmt(session?.startAt ?? null) }));
        ws.reload();
        return;
      }
      if (code === "SESSION_START_WINDOW_CLOSED") {
        toast.error(t("teacher.live.startWindowClosed"));
        ws.reload();
        return;
      }
      toast.error(String(result.body?.error ?? t("live.loadError")));
      return;
    }
    toast.success(action === "start" ? t("teacher.live.started") : t("teacher.live.ended"));
    ws.reload();
    onChanged();
  };

  if (ws.loading) return <Skeleton className="h-96" />;
  if (ws.error || !session) {
    return (
      <Card>
        <CardContent className="py-10 flex flex-col items-center gap-3">
          <AlertTriangle className="w-6 h-6 text-destructive" />
          <p className="text-sm">{t("live.loadError")}</p>
          <Button size="sm" variant="outline" onClick={ws.reload}>
            {t("live.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const pct = draftCounts.total > 0 ? Math.round((draftCounts.marked / draftCounts.total) * 100) : 0;

  return (
    <div className="space-y-4">
      <Card className="glass">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0">
              <h2 className="font-bold break-words">{session.titleAr || session.title}</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {fmt(session.startAt)} — {fmt(session.endsAt)} • {t("live.duration", { p1: session.duration })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("live.group")}: {session.group?.name ?? "—"}
                {session.lesson ? ` • ${t("live.lesson")}: ${session.lesson.titleAr || session.lesson.title}` : ""}
              </p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Badge variant={session.status === "LIVE" ? "default" : session.status === "CANCELLED" ? "destructive" : "outline"}>
                {t(statusKey(session.status))}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {t(reviewKey(session.reviewState))}
              </Badge>
            </div>
          </div>

          {session.substituteTeacher && (
            <p className="text-xs rounded-md border border-dashed p-2">
              {t("teacher.live.viaSubstitute")} — {session.substituteTeacher.name}
            </p>
          )}

          {session.rescheduleCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("teacher.live.reschedule")}: {session.rescheduleCount}× • {t("live.status.scheduled")}: {fmt(session.joinOpensAt)}
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <SessionLinkActions
              sessionId={session.id}
              status={session.status}
              state={{
                allowed: session.joinAllowed,
                denialCode: session.joinDenialCode,
                opensAt: session.joinOpensAt,
                closesAt: session.joinClosesAt,
                joinEarlyMinutes: session.joinEarlyMinutes ?? null,
              }}
            />
            {session.status === "SCHEDULED" && (
              // Finding 3 — starting early is refused by the SERVER (the
              // lifecycle authority). The UI mirrors that rule so the teacher
              // sees why the button is not available instead of a failure
              // toast after the fact.
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => lifecycle("start")}
                  disabled={busy || session.startAllowed === false}
                  title={
                    session.startAllowed === false && session.startDenialCode === "TOO_EARLY"
                      ? t("teacher.live.startTooEarly", { p1: fmt(session.startAt) })
                      : undefined
                  }
                >
                  <Play className="w-4 h-4 ms-1.5" />
                  {t("teacher.live.start")}
                </Button>
                {session.startAllowed === false ? (
                  <span className="text-[11px] text-muted-foreground max-w-56">
                    {session.startDenialCode === "TOO_EARLY"
                      ? t("teacher.live.startTooEarly", { p1: fmt(session.startAt) })
                      : t("teacher.live.startWindowClosed")}
                  </span>
                ) : null}
              </div>
            )}
            {session.status === "LIVE" && (
              <Button size="sm" variant="outline" onClick={() => lifecycle("end")} disabled={busy}>
                {t("teacher.live.end")}
              </Button>
            )}
            {session.status !== "CANCELLED" && session.status !== "COMPLETED" && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setRescheduleOpen(true)} disabled={busy}>
                  {t("teacher.live.reschedule")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => setCancelOpen(true)}
                  disabled={busy}
                >
                  {t("teacher.live.cancel")}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="glass">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-sm">{t("teacher.live.attendance")}</h3>
              {locked && (
                <Badge variant="secondary" className="gap-1 text-[10px]">
                  <Lock className="w-3 h-3" />
                  {t("teacher.live.locked")}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {dirty && !locked && (
                <span className="text-[11px] text-amber-600">{t("teacher.live.unsaved")}</span>
              )}
              <span className="text-xs text-muted-foreground">
                {t("teacher.live.completion", { p1: draftCounts.marked, p2: draftCounts.total })}
              </span>
            </div>
          </div>

          <Progress value={pct} className="h-2" />

          {locked ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" />
              {t("teacher.live.attendanceByAdmin")}
              {session.attendanceFinalizedAt ? ` • ${fmt(session.attendanceFinalizedAt)}` : ""}
            </p>
          ) : session.status === "SCHEDULED" ? (
            <p className="text-xs text-muted-foreground">{t("teacher.live.windowNotOpen")}</p>
          ) : null}

          {!locked && (
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-48">
                <Search className="w-4 h-4 absolute top-2.5 start-2.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("teacher.live.search")}
                  className="ps-8"
                />
              </div>
              <Button size="sm" variant="outline" onClick={markAllPresent} disabled={roster.length === 0}>
                <Zap className="w-4 h-4 ms-1.5" />
                {t("teacher.live.markAllPresent")}
              </Button>
              <Button size="sm" onClick={save} disabled={busy || !dirty}>
                <Check className="w-4 h-4 ms-1.5" />
                {t("teacher.live.save")}
              </Button>
              <Button size="sm" variant="default" onClick={() => setFinalizeOpen(true)} disabled={busy}>
                <Lock className="w-4 h-4 ms-1.5" />
                {t("teacher.live.finalize")}
              </Button>
            </div>
          )}

          {roster.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t("teacher.live.noStudents")}</p>
          ) : (
            <ScrollArea className="min-h-0" viewportClassName="max-h-[min(52dvh,calc(100dvh-24rem))] min-h-0 overscroll-contain">
              <ul className="pb-1 space-y-1">
                {filtered.map((row) => {
                  const status = statusFor(row);
                  return (
                    <li
                      key={row.studentId}
                      className="flex items-center gap-2 flex-wrap rounded-lg border p-2"
                    >
                      <div className="flex-1 min-w-40">
                        <p className="text-sm font-medium truncate">{row.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {row.studentCode ? `${row.studentCode} • ` : ""}
                          {t("teacher.live.overall")}: {row.overallPct === null ? "—" : `${row.overallPct}%`}
                          {" • "}
                          {t(attendanceKey(status))}
                        </p>
                      </div>
                      {locked ? (
                        <Badge variant="secondary">{t(attendanceKey(status))}</Badge>
                      ) : (
                        <div className="flex gap-1">
                          {(["PRESENT", "LATE", "ABSENT"] as const).map((option) => (
                            <Button
                              key={option}
                              size="sm"
                              variant={status === option ? "default" : "outline"}
                              className="h-7 px-2 text-xs"
                              onClick={() => setStatus(row.studentId, option)}
                              aria-pressed={status === option}
                            >
                              {t(attendanceKey(option))}
                            </Button>
                          ))}
                          {status !== "UNMARKED" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-1.5"
                              onClick={() => setStatus(row.studentId, "UNMARKED")}
                              aria-label={t("live.attendance.unmarked")}
                            >
                              <X className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Finalize — the confirmation states the counter and, when students are
          unmarked, exactly what will happen (flagged for review, NOT absent). */}
      <Dialog open={finalizeOpen} onOpenChange={setFinalizeOpen}>
        <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t("teacher.live.finalize")}</DialogTitle>
            <DialogDescription>
              {t("teacher.live.completion", { p1: draftCounts.marked, p2: draftCounts.total })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 py-2">
            <p className="text-sm text-muted-foreground">{t("teacher.live.finalizeConfirm")}</p>
            {draftCounts.unmarked > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
                <p className="text-xs text-amber-800 dark:text-amber-200 flex items-start gap-1.5">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  {t("teacher.live.unmarkedWarn", { p1: draftCounts.unmarked })}
                </p>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={ackUnmarked} onCheckedChange={(v) => setAckUnmarked(Boolean(v))} />
                  {t("teacher.live.ackUnmarked")}
                </label>
              </div>
            )}
            {/* Finding 5 — a disabled button must SAY WHY, in the UI itself.
                Hover-only `title` text is invisible on touch, to keyboard users
                and to anyone who does not hover the exact spot. */}
            {finalizeBlockedReason ? (
              <div
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 flex items-start gap-2"
                role="status"
                data-testid="finalize-blocked-reason"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
                <p className="text-xs text-destructive">{t(finalizeBlockedReason)}</p>
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setFinalizeOpen(false)}>
              {t("plan.018")}
            </Button>
            <Button
              onClick={finalize}
              disabled={busy || Boolean(finalizeBlockedReason)}
              title={finalizeBlockedReason ? t(finalizeBlockedReason) : undefined}
            >
              {t("teacher.live.finalize")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RescheduleDialog
        open={rescheduleOpen}
        onOpenChange={setRescheduleOpen}
        session={session}
        onDone={() => {
          ws.reload();
          onChanged();
        }}
      />

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t("teacher.live.cancel")}</DialogTitle>
            <DialogDescription>{t("teacher.live.cancelConfirm")}</DialogDescription>
          </DialogHeader>
          <CancelForm
            busy={busy}
            onSubmit={async (reason) => {
              setBusy(true);
              const result = await sendJson(`/api/live-sessions/${sessionId}/cancel`, "POST", { reason });
              setBusy(false);
              if (!result.ok) {
                toast.error(String(result.body?.error ?? t("live.loadError")));
                return;
              }
              toast.success(t("teacher.live.cancelled"));
              setCancelOpen(false);
              ws.reload();
              onChanged();
            }}
            onClose={() => setCancelOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function CancelForm({
  busy,
  onSubmit,
  onClose,
}: {
  busy: boolean;
  onSubmit: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [reason, setReason] = React.useState("");
  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2 py-2">
        <Label htmlFor="cancel-reason">{t("teacher.live.cancelReason")}</Label>
        <Textarea id="cancel-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <DialogFooter className="gap-2">
        <Button variant="outline" onClick={onClose}>
          {t("live.close")}
        </Button>
        <Button variant="destructive" onClick={() => void onSubmit(reason)} disabled={busy}>
          {t("teacher.live.cancel")}
        </Button>
      </DialogFooter>
    </>
  );
}

function RescheduleDialog({
  open,
  onOpenChange,
  session,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  session: SessionRow;
  onDone: () => void;
}) {
  const t = useT();
  const [startAt, setStartAt] = React.useState(toLocalInput(session.startAt));
  const [duration, setDuration] = React.useState(String(session.duration));
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setStartAt(toLocalInput(session.startAt));
      setDuration(String(session.duration));
      setReason("");
    }
  }, [open, session]);

  const submit = async () => {
    setBusy(true);
    const result = await sendJson(`/api/live-sessions/${session.id}/reschedule`, "POST", {
      startAt: new Date(startAt).toISOString(),
      duration: Number(duration),
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
          <DialogDescription>{t("teacher.live.rescheduleNewStart")}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 py-2">
          <div>
            <Label htmlFor="reschedule-start">{t("teacher.live.rescheduleNewStart")}</Label>
            <Input
              id="reschedule-start"
              type="datetime-local"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="reschedule-duration">{t("live.durationLabel")}</Label>
            <Input
              id="reschedule-duration"
              type="number"
              min={15}
              max={600}
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="reschedule-reason">{t("teacher.live.rescheduleReason")}</Label>
            <Textarea id="reschedule-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("live.close")}
          </Button>
          <Button onClick={submit} disabled={busy || !startAt}>
            {t("teacher.live.reschedule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScheduleDialog({
  open,
  onOpenChange,
  groups,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groups: Array<{ id: string; name: string; courseId: string }>;
  onCreated: () => void;
}) {
  const t = useT();
  const [groupId, setGroupId] = React.useState("");
  const [lessonId, setLessonId] = React.useState("");
  const [titleAr, setTitleAr] = React.useState("");
  const [startAt, setStartAt] = React.useState(toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [duration, setDuration] = React.useState("120");
  const [meetingUrl, setMeetingUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const locale = useApp((s) => (s.locale === "en" ? "en" : "ar")) as Locale;
  const lessons = useJson<{ lessons: Array<{ id: string; title: string; titleAr: string; officialCode?: string | null; courseId?: string }> }>(
    open && groupId ? `/api/teacher/lessons?groupId=${groupId}` : null
  );
  // Finding 2 — only a Lesson belonging to the SELECTED GROUP's course may be
  // scheduled (the teacher API scopes them; the server re-validates anyway).
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
  const selectedLessonLabel = lessonOptions.find((o) => o.value === lessonId)?.label ?? "";

  React.useEffect(() => {
    if (open && groups.length > 0 && !groupId) setGroupId(groups[0].id);
  }, [open, groups, groupId]);

  // Switching group invalidates the chosen lesson (it may belong to another
  // course entirely) — the teacher must re-pick from the new group's course.
  React.useEffect(() => {
    setLessonId("");
  }, [groupId]);

  const submit = async () => {
    if (!groupId) {
      toast.error(t("admin.live.filterGroup"));
      return;
    }
    // Finding 2 — a session is an OCCURRENCE of a canonical Lesson: the link is
    // mandatory, the free-text title is only an optional display override.
    if (!lessonId) {
      toast.error(t("live.lesson.pick"));
      return;
    }
    setBusy(true);
    const result = await sendJson("/api/live-sessions", "POST", {
      groupId,
      lessonId,
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
    setTitleAr("");
    setMeetingUrl("");
    setLessonId("");
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("teacher.live.schedule")}</DialogTitle>
          <DialogDescription>{t("teacher.live.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 py-2">
          <div>
            <Label>{t("live.group")}</Label>
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("live.group")} />
              </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("live.lesson")}</Label>
            <EntitySelect
              value={lessonId}
              onChange={setLessonId}
              options={lessonOptions}
              placeholder={t("live.lesson.pick")}
              searchPlaceholder={t("live.filter.searchGroups")}
              allLabel={t("live.lesson.pick")}
              emptyLabel={t("live.lesson.none")}
              loading={lessons.loading}
              error={lessons.error ? t("live.lesson.loadError") : null}
              onRetry={lessons.reload}
              disabled={!groupId}
            />
            {lessonId ? (
              <div className="text-[11px] text-emerald-600 mt-1 truncate">{selectedLessonLabel}</div>
            ) : null}
          </div>
          <div>
            <Label htmlFor="schedule-title">{t("live.lesson.optionalTitle")}</Label>
            <Input
              id="schedule-title"
              value={titleAr}
              maxLength={200}
              placeholder={selectedLessonLabel}
              onChange={(e) => setTitleAr(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground mt-1">{t("live.lesson.optionalHint")}</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="schedule-start">{t("live.startAt")}</Label>
              <Input
                id="schedule-start"
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="schedule-duration">{t("live.durationLabel")}</Label>
              <Input
                id="schedule-duration"
                type="number"
                min={15}
                max={600}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="schedule-url">{t("teacher.live.meetingUrl")}</Label>
            <Input
              id="schedule-url"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              placeholder="https://meet.google.com/…"
              inputMode="url"
            />
            <p className="text-[11px] text-muted-foreground mt-1">{t("teacher.live.meetingUrlHint")}</p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("live.close")}
          </Button>
          <Button onClick={submit} disabled={busy || !groupId || !lessonId || !startAt}>
            {t("live.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default TeacherLiveSessionsWorkspace;
