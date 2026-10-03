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
import { useT, useLocale, localeDirection } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { fmtDateTime as formatDateTime, type Locale } from "@/lib/i18n-core";
import { EntitySelect, type EntityOption } from "@/components/shared/entity-select";
import {
  AcademicLevelBadge,
  academicLevelLabel,
} from "@/components/admin/academic-level-ui";
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
import {
  AlertTriangle,
  BookOpen,
  CalendarDays,
  CalendarPlus,
  Check,
  ClipboardCheck,
  Clock,
  Lock,
  Play,
  Search,
  Users,
  X,
  Zap,
} from "lucide-react";

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
  group: { id: string; name: string; courseId: string; academicLevel?: string | null } | null;
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

/**
 * The summary chips' palette — the SAME status colours the register rows and
 * the rest of the platform use (emerald = present, amber = late, rose =
 * absent, muted = not marked yet). Presentation only.
 */
const ATTENDANCE_SUMMARY_CLASS: Record<"PRESENT" | "LATE" | "ABSENT" | "UNMARKED", string> = {
  PRESENT: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  LATE: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  ABSENT: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  UNMARKED: "border-border bg-muted/40 text-muted-foreground",
};

/** Date only (localized) — the shared formatter with an explicit set of options. */
function fmtDateOnly(value: string | null, locale: Locale): string {
  if (!value) return "";
  return formatDateTime(value, locale, { day: "numeric", month: "long", year: "numeric" });
}

/** Time only (localized), e.g. "٥:٣٠ م" / "17:30". */
function fmtTimeOnly(value: string | null, locale: Locale): string {
  if (!value) return "";
  return formatDateTime(value, locale, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Short "day month, hh:mm" for the narrow session list. Same shared formatter,
 * shorter option set — the narrow column keeps the real instant without
 * truncating the row.
 */
function fmtDateTimeShort(value: string | null, locale: Locale): string {
  if (!value) return "";
  return formatDateTime(value, locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
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

  const list = useJson<{ sessions: SessionRow[]; groups: Array<{ id: string; name: string; courseId: string; academicLevel?: string | null }> }>(
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
        // Phase L final polish 2 — desktop balance: the detail column takes the
        // remaining space (~70%) and the list column is a proportional slice
        // with a floor for long Arabic titles (`30%`, never narrower than 18rem
        // and never wider than 24rem). Everything stays in layout utilities —
        // no hard-coded pixel width — and the list column sticks while the
        // detail panel scrolls.
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)] xl:grid-cols-[minmax(0,7fr)_minmax(20rem,3fr)]">
          {selectedId ? (
            <div className="order-2 min-w-0 lg:order-1" aria-label={t("teacher.live.details")}>
              <SessionDetail
                key={selectedId}
                sessionId={selectedId}
                groups={groups}
                onChanged={list.reload}
              />
            </div>
          ) : (
            <Card className="glass order-2 lg:order-1">
              <CardContent className="py-10 text-center">
                <p className="text-sm text-muted-foreground">{t("teacher.live.selectSession")}</p>
              </CardContent>
            </Card>
          )}

          <SessionListCard
            sessions={sessions}
            selectedId={selectedId}
            onSelect={setSelectedId}
            className="order-1 lg:order-2"
          />
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
// The session LIST (the secondary column)
// ---------------------------------------------------------------------------
//
// IDENTITY RULE (Phase L final polish): every row is keyed and selected by the
// session's canonical `id` — never by a title, a group name or a date. The
// course/level and the group name are DISPLAY text: two official courses share
// one display name, so a display value can never be an identity here.
//
// Nothing in this component decides lifecycle: it renders `status` exactly as
// the server computed it, and a click only changes which session is shown.

function SessionListCard({
  sessions,
  selectedId,
  onSelect,
  className,
}: {
  sessions: SessionRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Grid placement/order — the card itself is a direct child of the layout. */
  className?: string;
}) {
  const t = useT();
  const locale = useApp((s) => (s.locale === "en" ? "en" : "ar")) as Locale;
  const fmtShort = (value: string | null) => fmtDateTimeShort(value, locale);

  return (
    <Card className={`glass lg:sticky lg:top-4 ${className ?? ""}`}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold">{t("teacher.live.list")}</h2>
          <Badge variant="outline" className="tabular-nums">{sessions.length}</Badge>
        </div>
        <ScrollArea
          className="min-h-0"
          viewportClassName="max-h-[min(62dvh,calc(100dvh-16rem))] overscroll-contain"
        >
          <ul className="pb-1 space-y-1">
            {sessions.map((s) => {
              const selected = selectedId === s.id;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(s.id)}
                    className={`relative w-full min-w-0 rounded-lg border px-2.5 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                      selected
                        ? "border-primary/50 bg-primary/15 ps-3 ring-1 ring-primary/30 shadow-sm"
                        : "border-border/50 ps-2.5 hover:border-border hover:bg-muted/60"
                    }`}
                    aria-current={selected ? "true" : undefined}
                    data-session-id={s.id}
                  >
                    {/* A start accent bar makes the selection obvious without
                        relying on border colour alone (colour-blind friendly). */}
                    {selected ? (
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-primary"
                      />
                    ) : null}
                    {/* A. title — up to two lines, never clipped mid-word... */}
                    <span className="block text-[13px] font-semibold leading-snug break-words line-clamp-2 [overflow-wrap:anywhere]">
                      {s.titleAr || s.title}
                    </span>
                    {/* B. level badge + group name ... */}
                    <span className="mt-1 flex min-w-0 items-center gap-1.5">
                      <AcademicLevelBadge level={s.group?.academicLevel} />
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {s.group?.name ?? ""}
                      </span>
                    </span>
                    {/* C. time · duration · status — one aligned metadata line
                        (RTL audit: the status sits at the logical END of the row
                        via `ms-auto`, so it lines up in both directions). */}
                    <span className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="truncate">
                        {fmtShort(s.startAt)} • {t("live.duration", { p1: s.duration })}
                      </span>
                      <Badge
                        variant={
                          s.status === "LIVE"
                            ? "default"
                            : s.status === "CANCELLED"
                              ? "destructive"
                              : "outline"
                        }
                        className="ms-auto h-5 shrink-0 px-1.5 text-[10px] font-medium"
                      >
                        {t(statusKey(s.status))}
                      </Badge>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </CardContent>
    </Card>
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
  groups: Array<{ id: string; name: string; courseId: string; academicLevel?: string | null }>;
  onChanged: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const direction = localeDirection(locale);
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

  // -------------------------------------------------------------------------
  // Phase L final polish — ACTION PRIORITY (presentation only).
  //
  // The lifecycle authority is the SERVER: `status`, `startAllowed`,
  // `joinAllowed` and `attendanceLocked` all arrive decided. This block only
  // decides WHICH of the already-allowed actions is allowed to dominate the
  // page, so the screen reads clearly during a live class:
  //
  //   SCHEDULED → "بدء الحصة" is primary; when the server says starting is too
  //               early the primary becomes the join control if the join window
  //               is already open, otherwise the start button is shown MUTED
  //               with its reason instead of shouting a dead solid button.
  //   LIVE      → the join control is primary; "إنهاء الحصة" is secondary.
  //   ENDED /
  //   CANCELLED → NOTHING is primary; no disabled start button is emphasised.
  //
  // Nothing below changes an endpoint, a payload or a transition.
  const phase: "LIVE" | "SCHEDULED" | "ENDED" | "CANCELLED" | "OTHER" =
    session.status === "LIVE"
      ? "LIVE"
      : session.status === "SCHEDULED"
        ? "SCHEDULED"
        : session.status === "COMPLETED"
          ? "ENDED"
          : session.status === "CANCELLED"
            ? "CANCELLED"
            : "OTHER";
  /** Starting is only "blocked" when the SERVER said so for this session. */
  const startBlocked = phase === "SCHEDULED" && session.startAllowed === false;
  /** The join window is open right now (server-decided, never inferred). */
  const joinReady = session.joinAllowed === true && phase !== "ENDED" && phase !== "CANCELLED";
  /** Exactly one slot may be emphasised. */
  const primaryAction: "JOIN" | "START" | "NONE" =
    phase === "LIVE"
      ? "JOIN"
      : phase === "SCHEDULED"
        ? startBlocked
          ? joinReady
            ? "JOIN"
            : "START"
          : "START"
        : "NONE";
  /** Reschedule/cancel keep the EXACT conditions they had before the polish. */
  const manageable = session.status !== "CANCELLED" && session.status !== "COMPLETED";
  /**
   * Final polish banding — where the destructive ceremony lives.
   *
   * The lifecycle authority is STILL the server (`manageable`); this only
   * decides on which row the cancel button is placed, so a destructive action
   * can never sit shoulder-to-shoulder with the primary one:
   *   * SCHEDULED / LIVE → its own band under the utility row;
   *   * ENDED             → the session can no longer be cancelled, so the band
   *                         holds nothing and is not rendered at all.
   */
  const showDestructiveBand = manageable;
  const startBlockReason =
    session.startDenialCode === "TOO_EARLY"
      ? t("teacher.live.startTooEarly", { p1: fmt(session.startAt) })
      : t("teacher.live.startWindowClosed");

  return (
    // The detail panel and the attendance register are ONE workspace: the same
    // 10px rhythm inside the card and between the cards keeps them visually
    // attached (page-level gaps stay wider — `gap-4` — so the panel still reads
    // as a unit against the rest of the page).
    <div className="space-y-2.5">
      {/* ================= A. HEADER — identity of the selected session ===== */}
      <Card className="glass">
        <CardContent className="p-4 space-y-2.5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1 basis-64">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-base font-bold leading-snug break-words">
                  {session.titleAr || session.title}
                </h2>
                <AcademicLevelBadge level={session.group?.academicLevel} />
                <Badge
                  variant={
                    session.status === "LIVE"
                      ? "default"
                      : session.status === "CANCELLED"
                        ? "destructive"
                        : "outline"
                  }
                >
                  {t(statusKey(session.status))}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t(reviewKey(session.reviewState))}
                {session.rescheduleCount > 0
                  ? ` • ${t("teacher.live.reschedule")}: ${session.rescheduleCount}× • ${t("live.status.scheduled")}: ${fmt(session.joinOpensAt)}`
                  : ""}
              </p>
            </div>
          </div>

          {session.substituteTeacher && (
            <p className="text-xs rounded-md border border-dashed p-2">
              {t("teacher.live.viaSubstitute")} — {session.substituteTeacher.name}
            </p>
          )}

          {/* ================= B. CONTEXT — scannable at a glance ============ */}
          <dl className="grid grid-cols-1 gap-x-5 gap-y-1.5 border-t pt-3 sm:grid-cols-2">
            <ContextItem
              icon={<CalendarDays className="w-3.5 h-3.5" />}
              label={t("teacher.live.date")}
              value={fmtDateOnly(session.startAt, locale)}
            />
            <ContextItem
              icon={<Clock className="w-3.5 h-3.5" />}
              label={t("teacher.live.time")}
              value={`${fmtTimeOnly(session.startAt, locale)} — ${fmtTimeOnly(session.endsAt, locale)}`}
              hint={t("live.duration", { p1: session.duration })}
            />
            <ContextItem
              icon={<Users className="w-3.5 h-3.5" />}
              label={t("live.group")}
              value={session.group?.name ?? "—"}
              badge={<AcademicLevelBadge level={session.group?.academicLevel} />}
            />
            <ContextItem
              icon={<BookOpen className="w-3.5 h-3.5" />}
              label={t("live.lesson")}
              value={
                session.lesson
                  ? session.lesson.titleAr || session.lesson.title
                  : t("live.lesson.unlinked")
              }
              code={session.lesson?.officialCode ?? null}
            />
          </dl>

          {/* ================= C. ACTIONS — primary + utilities in ONE band ===
              The metadata grid above is divided from this band by a hairline, so
              the two scan zones read as a unit instead of two loose blocks. */}
          <div className="space-y-2.5 border-t pt-3.5">
            <div
              className="flex flex-wrap items-center gap-2"
              data-live-primary={primaryAction}
              role="group"
              aria-label={t("teacher.live.actions")}
            >
            {primaryAction === "JOIN" && (
              <SessionLinkActions
                sessionId={session.id}
                status={session.status}
                testId="live-primary-join"
                state={{
                  allowed: session.joinAllowed,
                  denialCode: session.joinDenialCode,
                  opensAt: session.joinOpensAt,
                  closesAt: session.joinClosesAt,
                  joinEarlyMinutes: session.joinEarlyMinutes ?? null,
                }}
              />
            )}
            {primaryAction === "START" && (
              <>
                <Button
                  size="sm"
                  variant={startBlocked ? "outline" : "default"}
                  onClick={() => lifecycle("start")}
                  disabled={busy || startBlocked}
                  title={startBlocked ? startBlockReason : undefined}
                >
                  {/* RTL audit — the play triangle points in the reading
                      direction (the repo's own `.flip-rtl` helper). */}
                  <Play className="w-4 h-4 ms-1.5 flip-rtl" />
                  {t("teacher.live.start")}
                </Button>
                {startBlocked ? (
                  <span className="text-[11px] text-muted-foreground">{startBlockReason}</span>
                ) : null}
              </>
            )}
            {phase === "LIVE" && (
              <Button size="sm" variant="secondary" onClick={() => lifecycle("end")} disabled={busy}>
                {t("teacher.live.end")}
              </Button>
            )}
            {primaryAction === "NONE" && (
              <span
                className="rounded-lg border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
                data-live-ended={phase}
              >
                {phase === "CANCELLED" ? t("live.join.cancelled") : t("live.join.ended")}
              </span>
            )}
            </div>

            {/* D. SECONDARY UTILITIES — present in EVERY phase (never hide the
                copy control); they stay flat and tonally quiet. */}
            <div
              className="flex flex-wrap items-center gap-1.5"
              data-live-utilities="true"
              role="group"
              aria-label={t("teacher.live.moreActions")}
            >
            {primaryAction !== "JOIN" && (
              <SessionLinkActions
                sessionId={session.id}
                status={session.status}
                size="sm"
                joinVariant="outline"
                state={{
                  allowed: session.joinAllowed,
                  denialCode: session.joinDenialCode,
                  opensAt: session.joinOpensAt,
                  closesAt: session.joinClosesAt,
                  joinEarlyMinutes: session.joinEarlyMinutes ?? null,
                }}
              />
            )}
            {manageable && (
              <Button size="sm" variant="ghost" onClick={() => setRescheduleOpen(true)} disabled={busy}>
                <CalendarDays className="w-4 h-4 ms-1.5" />
                {t("teacher.live.reschedule")}
              </Button>
            )}
            </div>

            {/* D2. DESTRUCTIVE — isolated on its own hairline so it can never be
                mistaken for the primary action, and still clearly destructive. */}
            {showDestructiveBand && (
              <div
                className="flex flex-wrap items-center gap-2 border-t pt-2"
                data-live-destructive="true"
              >
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setCancelOpen(true)}
                  disabled={busy}
                >
                  {t("teacher.live.cancel")}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {t("teacher.live.cancelConfirm")}
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ================= E. ATTENDANCE — belongs to THIS session =========
          The register is rendered inside the selected session's panel (never
          detached from it), and its heading repeats the session's own time so
          it is unambiguous which occurrence is being marked. Registration logic
          is untouched: the same draft, the same endpoints, the same lock. */}
      <Card className="glass" data-live-attendance-for={session.id}>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2 border-b pb-2.5">
            <div className="min-w-0">
              <h3 className="flex flex-wrap items-center gap-2 text-sm font-bold">
                <ClipboardCheck className="h-4 w-4 shrink-0 text-primary" />
                {t("teacher.live.attendance")}
                {locked && (
                  <Badge variant="secondary" className="gap-1 text-[10px]">
                    <Lock className="w-3 h-3" />
                    {t("teacher.live.locked")}
                  </Badge>
                )}
              </h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("teacher.live.summary")} • {fmt(session.startAt)}
              </p>
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

          {/* Compact registered/present summary — the same counts the register
              computes locally, shown before the rows so a teacher mid-class can
              read the state at a glance without scrolling. */}
          <div className="flex flex-wrap items-center gap-1.5" data-live-attendance-summary="true">
            {(
              [
                ["PRESENT", draftCounts.present],
                ["LATE", draftCounts.late],
                ["ABSENT", draftCounts.absent],
                ["UNMARKED", draftCounts.unmarked],
              ] as const
            ).map(([summaryStatus, count]) => (
              <span
                key={summaryStatus}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${ATTENDANCE_SUMMARY_CLASS[summaryStatus]}`}
              >
                {t(attendanceKey(summaryStatus))}
                <span className="font-bold tabular-nums">{count}</span>
              </span>
            ))}
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
            // RTL audit: the search field takes the start of the row and the
            // three tools hug the logical end; every control is the same height
            // (`h-9`) so the row has one baseline instead of three.
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1 basis-48">
                <Search className="absolute top-1/2 start-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("teacher.live.search")}
                  className="h-9 ps-8"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                onClick={markAllPresent}
                disabled={roster.length === 0}
              >
                <Zap className="h-4 w-4 ms-1.5" />
                {t("teacher.live.markAllPresent")}
              </Button>
              {/* The register's own primary: saving the LOCAL draft is the one
                  action the teacher must not miss; finalize keeps its own solid
                  weight but is rendered as the secondary of the pair. */}
              <Button size="sm" className="h-9" onClick={save} disabled={busy || !dirty}>
                <Check className="h-4 w-4 ms-1.5" />
                {t("teacher.live.save")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-9"
                onClick={() => setFinalizeOpen(true)}
                disabled={busy}
              >
                <Lock className="h-4 w-4 ms-1.5" />
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
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5"
                    >
                      <div className="min-w-40 flex-1">
                        <p className="truncate text-[13px] font-medium leading-snug">{row.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {row.studentCode ? `${row.studentCode} • ` : ""}
                          {t("teacher.live.overall")}: {row.overallPct === null ? "—" : `${row.overallPct}%`}
                          {" • "}
                          {t(attendanceKey(status))}
                        </p>
                      </div>
                      {locked ? (
                        <Badge variant="secondary">{t(attendanceKey(status))}</Badge>
                      ) : (
                        <div className="flex shrink-0 items-center gap-1">
                          {(["PRESENT", "LATE", "ABSENT"] as const).map((option) => (
                            <Button
                              key={option}
                              size="sm"
                              variant={status === option ? "default" : "outline"}
                              className={`h-7 px-2 text-[11px] ${
                                status !== option ? "text-muted-foreground" : ""
                              }`}
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
        <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col" dir={direction}>
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
        <DialogContent className="sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col" dir={direction}>
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

/**
 * One labelled fact about the selected session (B — context).
 *
 * Presentation only: the value is whatever the server sent (a group name, a
 * lesson title, a formatted time). The optional `badge` carries the canonical
 * academic level so a group of either level stays identifiable even when two
 * groups/courses share a display name.
 */
function ContextItem({
  icon,
  label,
  value,
  hint,
  badge,
  code,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  badge?: React.ReactNode;
  /** Canonical curriculum code (officialCode) — rendered LTR, monospaced. */
  code?: string | null;
}) {
  return (
    // RTL audit: one fixed label column (`dt`) so every value starts on the same
    // optical line; `start-*`/`text-start` logical utilities only, no physical
    // left/right, so LTR and RTL both line up.
    <div className="flex min-w-0 items-start gap-2">
      <dt className="flex w-[5.5rem] shrink-0 items-center gap-1.5 pt-0.5 text-[11px] font-medium text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </dt>
      <dd className="min-w-0 flex-1 pt-0.5 text-sm font-semibold leading-snug break-words">
        <span className="flex flex-wrap items-center gap-1.5">
          {code ? (
            <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">
              {code}
            </Badge>
          ) : null}
          <span className="min-w-0 break-words">{value}</span>
          {badge}
        </span>
        {hint ? <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{hint}</span> : null}
      </dd>
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
        <Textarea id="cancel-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} dir="auto" />
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
  const direction = localeDirection(useLocale());
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
      <DialogContent className="sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col" dir={direction}>
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
            <Textarea id="reschedule-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} dir="auto" />
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

export function ScheduleDialog({
  open,
  onOpenChange,
  groups,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  groups: Array<{ id: string; name: string; courseId: string; academicLevel?: string | null }>;
  onCreated: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const direction = localeDirection(locale);
  const [groupId, setGroupId] = React.useState("");
  const [lessonId, setLessonId] = React.useState("");
  const [titleAr, setTitleAr] = React.useState("");
  const [startAt, setStartAt] = React.useState(toLocalInput(new Date(Date.now() + 60 * 60 * 1000)));
  const [duration, setDuration] = React.useState("120");
  const [meetingUrl, setMeetingUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // `useJson` intentionally retains its last successful value during a reload.
  // Track the group whose request is current so a just-changed group can never
  // render that previous group's lesson options, even for the render before the
  // new request effect starts.
  const [lessonsRequestGroupId, setLessonsRequestGroupId] = React.useState("");

  const lessons = useJson<{
    lessons: Array<{
      id: string;
      title: string;
      titleAr: string;
      officialCode?: string | null;
      courseId?: string;
      course?: { id: string; name: string; academicLevel?: string | null } | null;
    }>;
  }>(
    open && groupId
      ? `/api/teacher/lessons?groupId=${encodeURIComponent(groupId)}`
      : null
  );
  React.useEffect(() => {
    setLessonsRequestGroupId(groupId);
  }, [groupId]);

  const lessonRequestIsCurrent = lessonsRequestGroupId === groupId;
  const scopedLessonsLoading =
    open && !!groupId && (!lessonRequestIsCurrent || lessons.loading);
  const scopedLessonsError =
    lessonRequestIsCurrent && !lessons.loading ? lessons.error : null;
  // Finding 2 — only a Lesson belonging to the SELECTED GROUP's course may be
  // scheduled (the teacher API scopes them; the server re-validates anyway).
  /** The group currently chosen in the dialog (display context only). */
  const selectedGroup = React.useMemo(
    () => groups.find((g) => g.id === groupId) ?? null,
    [groups, groupId]
  );

  const lessonOptions: EntityOption[] = React.useMemo(
    () =>
      (!lessonRequestIsCurrent || scopedLessonsLoading || scopedLessonsError
        ? []
        : lessons.data?.lessons ?? []
      ).map((l) => {
        // Phase L manual-QA fix — the lesson's canonical level leads the label
        // (the level is the ONLY thing distinguishing two official courses that
        // share one display name, and their lessons share printed codes).
        const level = l.course?.academicLevel ? academicLevelLabel(t, l.course.academicLevel) : "";
        const identity =
          sessionLessonIdentity(
            { officialCode: l.officialCode ?? null, title: l.title, titleAr: l.titleAr },
            locale
          ) ?? l.id;
        return { value: l.id, label: level ? `${level} · ${identity}` : identity };
      }),
    [lessonRequestIsCurrent, scopedLessonsLoading, scopedLessonsError, lessons.data, locale, t]
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
      <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col" dir={direction}>
        <DialogHeader>
          <DialogTitle>{t("teacher.live.schedule")}</DialogTitle>
          <DialogDescription>{t("teacher.live.subtitle")}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 py-2">
          <div>
            <Label htmlFor="schedule-group">{t("live.group")}</Label>
            <Select
              value={groupId}
              onValueChange={(nextGroupId) => {
                if (nextGroupId !== groupId) setLessonId("");
                setGroupId(nextGroupId);
              }}
            >
              <SelectTrigger id="schedule-group" className="w-full">
                <SelectValue placeholder={t("live.group")} />
              </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {/* Phase L manual-QA fix — canonical group level first, so
                        two identically-named groups in different levels can
                        never be confused when scheduling a session. */}
                    {g.academicLevel
                      ? `${academicLevelLabel(t, g.academicLevel)} · ${g.name}`
                      : g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedGroup?.academicLevel ? (
            <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {t("teacher.live.level")}
              <AcademicLevelBadge level={selectedGroup.academicLevel} />
              <span className="truncate">{selectedGroup.name}</span>
            </p>
          ) : null}
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
              loading={scopedLessonsLoading}
              error={scopedLessonsError ? t("live.lesson.loadError") : null}
              onRetry={lessons.reload}
              disabled={!groupId || scopedLessonsLoading || !!scopedLessonsError}
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
