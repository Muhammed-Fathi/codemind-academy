// CodeMind Academy — Phase F student/parent faces of the live-session system.
//
// ONE file, THREE views, because they share the same two server authorities:
//   * `student-sessions`  — upcoming + past LiveSessions with the join/copy
//                           control (SessionLinkActions) and the student's own
//                           attendance fact;
//   * `student-absences`  — the student's absence cases: submit a reason,
//                           follow PENDING_REASON → PENDING_REVIEW →
//                           EXCUSED/UNEXCUSED, read the decision;
//   * `parent-absences`   — the SAME case list for a linked child, where the
//                           parent may read and submit a reason but the UI
//                           states plainly that attendance, the decision and
//                           the hold are not theirs to change.
//
// Every state the contract demands is present: loading skeleton, empty state,
// error with retry, disabled actions with a reason, confirmations for
// submissions, and success toasts.

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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SessionLinkActions } from "@/components/shared/session-link-actions";
import {
  sessionDisplayOverride,
  sessionLessonIdentity,
} from "@/lib/live-session-policy";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, MessageSquarePlus } from "lucide-react";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export type LiveSessionPayload = {
  id: string;
  title: string;
  titleAr: string;
  startAt: string;
  endsAt: string;
  duration: number;
  status: string;
  phase: string;
  reviewState: string;
  meetingProviderLabelKey: string | null;
  joinAllowed: boolean;
  joinDenialCode: string | null;
  joinOpensAt: string;
  joinClosesAt: string;
  /** Finding 4 — the CONFIGURED join-before window (server policy). */
  joinEarlyMinutes?: number;
  attendanceLocked: boolean;
  cancelledAt: string | null;
  cancelReason: string | null;
  rescheduleCount: number;
  originalStartAt: string | null;
  group: { id: string; name: string } | null;
  lesson: { id: string; title: string; titleAr: string } | null;
  teacher: { id: string; name: string } | null;
  substituteTeacher: { id: string; name: string } | null;
  myStatus?: string;
};

type AbsenceCase = {
  id: string;
  status: string;
  reason: string | null;
  reasonSubmittedAt: string | null;
  reasonSubmittedByRole: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  student: { id: string; name: string };
  session: { id: string; title: string; titleAr: string; startAt: string; endsAt: string; status: string };
  lesson: { id: string; title: string; titleAr: string; officialCode?: string | null } | null;
  group: { id: string; name: string } | null;
  teacherName: string | null;
  hold: { status: string } | null;
  submissions: Array<{ id: string; reason: string; role: string; at: string; byName: string | null }>;
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

function attendanceKey(status?: string | null): string {
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

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "LIVE") return "default";
  if (status === "CANCELLED") return "destructive";
  if (status === "COMPLETED") return "secondary";
  return "outline";
}

// ---------------------------------------------------------------------------
// One session card (shared with the parent surface)
// ---------------------------------------------------------------------------

export function LiveSessionCard({ session }: { session: LiveSessionPayload }) {
  const t = useT();
  const locale = useApp((s) => (s.locale === "en" ? "en" : "ar")) as Locale;
  const fmtDateTime = (value: string | null) => (value ? formatDateTime(value, locale) : "");
  // Finding 2 — the card leads with the canonical Lesson identity
  // (`1-1 — <title>`) and only falls back to the stored display title for a
  // legacy session that was never linked to a lesson.
  const lessonIdentity = sessionLessonIdentity(session.lesson, locale);
  const title = lessonIdentity ?? (session.titleAr || session.title);
  const teacherName = session.substituteTeacher?.name || session.teacher?.name || "";

  return (
    <Card className="glass">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <h3 className="font-bold text-sm break-words">{title}</h3>
            {lessonIdentity ? (
              (() => {
                const override = sessionDisplayOverride(session.titleAr || session.title, session.lesson, locale);
                return override ? (
                  <div className="text-[11px] text-muted-foreground truncate">{override}</div>
                ) : null;
              })()
            ) : (
              <div className="text-[11px] text-muted-foreground">{t("live.lesson.unlinked")}</div>
            )}
            <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
              <CalendarClock className="w-3.5 h-3.5" />
              {fmtDateTime(session.startAt)}
              <span aria-hidden="true">•</span>
              {t("live.duration", { p1: session.duration })}
            </p>
          </div>
          <Badge variant={statusVariant(session.status)}>{t(statusKey(session.status))}</Badge>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          {session.group && (
            <div>
              <span className="font-medium text-foreground">{t("live.group")}: </span>
              {session.group.name}
            </div>
          )}
          {teacherName && (
            <div>
              <span className="font-medium text-foreground">{t("live.teacher")}: </span>
              {teacherName}
            </div>
          )}
          {session.lesson && (
            <div className="col-span-2">
              <span className="font-medium text-foreground">{t("live.lesson")}: </span>
              {lessonIdentity}
            </div>
          )}
          {session.rescheduleCount > 0 && (
            <div className="col-span-2">
              <Badge variant="outline" className="text-[10px]">
                {t("live.status.scheduled")} — {session.rescheduleCount}×
              </Badge>
            </div>
          )}
        </div>

        {session.cancelReason && (
          <p className="text-xs text-destructive flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {session.cancelReason}
          </p>
        )}

        <SessionLinkActions
          sessionId={session.id}
          status={session.status}
          state={{
            allowed: session.joinAllowed,
            denialCode: session.joinDenialCode,
            opensAt: session.joinOpensAt,
            closesAt: session.joinClosesAt,
            // Finding 4 — the configured window comes from the server policy,
            // never from a number typed into this component.
            joinEarlyMinutes: session.joinEarlyMinutes ?? null,
          }}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// student-sessions
// ---------------------------------------------------------------------------

export function StudentLiveSessionsView() {
  const t = useT();
  const [tab, setTab] = React.useState<"upcoming" | "history">("upcoming");
  const url = tab === "upcoming" ? "/api/live-sessions" : "/api/live-sessions?history=1";
  const { data, loading, error, reload } = useJson<{ sessions: LiveSessionPayload[] }>(url);

  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-lg font-bold">{t("student.live.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("student.live.subtitle")}</p>
        </div>
        <div className="flex gap-1 rounded-lg border p-1">
          <Button
            size="sm"
            variant={tab === "upcoming" ? "default" : "ghost"}
            onClick={() => setTab("upcoming")}
          >
            {t("live.upcoming")}
          </Button>
          <Button size="sm" variant={tab === "history" ? "default" : "ghost"} onClick={() => setTab("history")}>
            {t("live.past")}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-10 flex flex-col items-center gap-3">
            <AlertTriangle className="w-6 h-6 text-destructive" />
            <p className="text-sm font-medium">{t("live.loadError")}</p>
            <Button size="sm" variant="outline" onClick={reload}>
              {t("live.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : sessions.length === 0 ? (
        <Card>
          <CardContent className="py-10 flex flex-col items-center gap-2 text-center">
            <Clock className="w-6 h-6 text-muted-foreground" />
            <p className="text-sm font-semibold">{tab === "upcoming" ? t("student.live.empty") : t("live.empty")}</p>
            <p className="text-xs text-muted-foreground">{t("live.emptyHint")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sessions.map((s) => (
            <div key={s.id} className="space-y-1">
              <LiveSessionCard session={s} />
              {tab === "history" && (
                <p className="text-xs text-muted-foreground px-1">
                  {t("live.myStatus")}: <span className="font-medium">{t(attendanceKey(s.myStatus))}</span>
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Absence cases (student + parent share the renderer)
// ---------------------------------------------------------------------------

function AbsenceCaseCard({
  item,
  canSubmit,
  onSubmitReason,
}: {
  item: AbsenceCase;
  /**
   * Phase I — the write affordance is opt-in at the CALL SITE, not inferred
   * from the case state. The parent view passes `false` and no handler: the
   * read-only rule is enforced server-side (403 PARENT_READ_ONLY), and the UI
   * simply never offers an action it may not perform.
   */
  canSubmit: boolean;
  onSubmitReason?: (id: string, reason: string) => Promise<boolean>;
}) {
  const t = useT();
  const locale = useApp((s) => (s.locale === "en" ? "en" : "ar")) as Locale;
  const fmtDateTime = (value: string | null) => (value ? formatDateTime(value, locale) : "");
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const pending = item.status === "PENDING_REASON";
  const decided = item.status === "EXCUSED" || item.status === "UNEXCUSED" || item.status === "NO_ACTION_REQUIRED";

  const submit = async () => {
    if (!onSubmitReason) return;
    const value = text.trim();
    if (value.length === 0) {
      toast.error(t("student.absences.reasonRequired"));
      return;
    }
    if (value.length < 3) {
      toast.error(t("student.absences.reasonTooShort"));
      return;
    }
    if (value.length > 1000) {
      toast.error(t("student.absences.reasonTooLong"));
      return;
    }
    setBusy(true);
    const okDone = await onSubmitReason(item.id, value);
    setBusy(false);
    if (okDone) {
      setOpen(false);
      setText("");
    }
  };

  return (
    <Card className="glass">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="min-w-0">
            <h3 className="font-bold text-sm break-words">{item.session.titleAr || item.session.title}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {fmtDateTime(item.session.startAt)}
              {item.group ? ` • ${item.group.name}` : ""}
              {item.teacherName ? ` • ${item.teacherName}` : ""}
            </p>
          </div>
          <Badge
            variant={
              item.status === "EXCUSED"
                ? "secondary"
                : item.status === "UNEXCUSED"
                  ? "destructive"
                  : "outline"
            }
          >
            {t(absenceStatusKey(item.status))}
          </Badge>
        </div>

        {item.lesson && (
          <p className="text-xs text-muted-foreground">
            {t("live.lesson")}: {item.lesson.titleAr || item.lesson.title}
          </p>
        )}

        <div className="rounded-lg border bg-muted/30 p-3 space-y-1">
          <p className="text-xs font-semibold">{t("absence.reason")}</p>
          <p className="text-xs text-muted-foreground break-words">
            {item.reason ? item.reason : t("admin.live.noReason")}
          </p>
          {item.reasonSubmittedAt && (
            <p className="text-[11px] text-muted-foreground/80">
              {t("admin.live.submittedBy")}: {item.reasonSubmittedByRole ?? ""} — {fmtDateTime(item.reasonSubmittedAt)}
            </p>
          )}
        </div>

        {decided && (
          <div className="rounded-lg border p-3 space-y-1">
            <p className="text-xs font-semibold flex items-center gap-1.5">
              {item.status === "EXCUSED" ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
              )}
              {t("student.absences.decision")}: {t(absenceStatusKey(item.status))}
            </p>
            {item.decisionNote && <p className="text-xs text-muted-foreground">{item.decisionNote}</p>}
            {item.decidedAt && (
              <p className="text-[11px] text-muted-foreground/80">{fmtDateTime(item.decidedAt)}</p>
            )}
            {item.hold && (
              <p className="text-[11px] text-muted-foreground">
                {t("admin.live.hold")}: {item.hold.status === "ACTIVE" ? t("absence.hold.active") : t("absence.hold.resolved")}
              </p>
            )}
          </div>
        )}

        {item.submissions.length > 1 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {t("student.absences.history")} ({item.submissions.length})
            </summary>
            <ul className="mt-2 space-y-1">
              {item.submissions.map((s) => (
                <li key={s.id} className="text-muted-foreground">
                  {fmtDateTime(s.at)} — {s.byName ?? s.role}: {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}

        {canSubmit ? (
          <Button size="sm" variant={pending ? "default" : "outline"} onClick={() => setOpen(true)}>
            <MessageSquarePlus className="w-4 h-4 ms-1.5" />
            {pending ? t("student.absences.submit") : t("student.absences.history")}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t("student.absences.awaitingDecision")}</p>
        )}
      </CardContent>

      {/* Phase I: the WRITE surface is not merely hidden — it is never
          mounted. The parent copy (`canSubmit={false}`) therefore holds no
          textarea, no submit button and no pending local reason text at all,
          which matches the server's 403 PARENT_READ_ONLY rather than relying on
          a hidden button to do the authorizing. */}
      {canSubmit ? (
      <Dialog open={open} onOpenChange={setOpen}>
        {/* The dialog is height-bounded and scrolls internally (the same
            pattern as session-open-dialog.tsx): a long reason on a short
            screen can never push the submit button out of reach. */}
        <DialogContent className="sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>{t("student.absences.submit")}</DialogTitle>
            <DialogDescription>{t("student.absences.subtitle")}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2 py-2">
            <Label htmlFor={`reason-${item.id}`}>{t("absence.reason")}</Label>
            <Textarea
              id={`reason-${item.id}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              maxLength={1000}
              placeholder={t("student.absences.reasonRequired")}
            />
            <p className="text-[11px] text-muted-foreground">{text.trim().length} / 1000</p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("plan.018")}
            </Button>
            <Button onClick={submit} disabled={busy || text.trim().length < 3}>
              {t("student.absences.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// student-absences
// ---------------------------------------------------------------------------

export function StudentAbsencesView() {
  const t = useT();
  const { data, loading, error, reload } = useJson<{ cases: AbsenceCase[] }>("/api/absence-reviews");
  const cases = data?.cases ?? [];

  const submitReason = async (id: string, reason: string): Promise<boolean> => {
    const result = await sendJson(`/api/absence-reviews/${id}/reason`, "POST", { reason });
    if (!result.ok) {
      toast.error(String(result.body?.error ?? t("student.absences.reasonRequired")));
      return false;
    }
    toast.success(t("student.absences.submitted"));
    reload();
    return true;
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold">{t("student.absences.title")}</h1>
        <p className="text-xs text-muted-foreground">{t("student.absences.subtitle")}</p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
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
      ) : cases.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("student.absences.empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {cases.map((item) => (
            <AbsenceCaseCard key={item.id} item={item} canSubmit={item.status !== "NO_ACTION_REQUIRED"} onSubmitReason={submitReason} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// parent-absences
// ---------------------------------------------------------------------------

export function ParentAbsencesView() {
  const t = useT();
  const { data, loading, error, reload } = useJson<{
    cases: AbsenceCase[];
    children: Array<{ id: string; name: string }>;
  }>("/api/absence-reviews");
  const [childId, setChildId] = React.useState<string>("");

  const cases = (data?.cases ?? []).filter((c) => !childId || c.student.id === childId);
  const children = data?.children ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h1 className="text-lg font-bold">{t("parent.absences.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("parent.absences.subtitle")}</p>
        </div>
        {children.length > 1 && (
          <div className="flex gap-1 rounded-lg border p-1">
            <Button size="sm" variant={!childId ? "default" : "ghost"} onClick={() => setChildId("")}>
              {t("admin.live.filterAll")}
            </Button>
            {children.map((c) => (
              <Button
                key={c.id}
                size="sm"
                variant={childId === c.id ? "default" : "ghost"}
                onClick={() => setChildId(c.id)}
              >
                {c.name}
              </Button>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-dashed bg-muted/20 p-3 text-xs text-muted-foreground">
        {t("parent.absences.readOnlyNotice")}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
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
      ) : cases.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("student.absences.empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {cases.map((item) => (
            <div key={item.id} className="space-y-1">
              <p className="text-xs font-semibold px-1">
                {t("parent.absences.child")}: {item.student.name}
              </p>
              {/* Phase I — READ-ONLY. No submit handler is passed and the
                  affordance is off: a parent follows the case, the submitted
                  reason, the administrative decision and the hold, and cannot
                  write any of them (the server refuses with 403
                  PARENT_READ_ONLY even if this prop were flipped). */}
              <AbsenceCaseCard item={item} canSubmit={false} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
