"use client";

// ============================================================
// CodeMind Academy — Admin: session lifecycle ceremonies
//
// Open / Mark-ready / Unpublish dialogs. Every action calls the
// server-side ceremony (`POST …/open`, `…/mark-ready`, `…/unpublish`)
// and renders the outcome the server returns:
//
//   • OK + changed            → the transition happened;
//   • NO_OP_ALREADY_IN_STATE  → idempotent replay: show existing state,
//                               never pretend a new publish occurred;
//   • READINESS_BLOCKED       → show the live blocking codes, refresh;
//   • anything else           → machine-readable error, safe retry.
//
// The UI never mutates `status` itself and never predicts the verdict:
// the checklist shown here is the server snapshot from the detail payload
// (refreshed after every ceremony).
// ============================================================

import * as React from "react";
import { toast } from "sonner";
import { useT, pickAuto } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, AlertTriangle } from "lucide-react";
import {
  CurriculumBadge,
  ReadinessChecklist,
  StatusBadge,
  TrackScopeBadge,
  fetchJson,
  readinessReasonText,
  serverErrorText,
  type AdminSessionDetail,
  type LessonReadinessSnapshot,
} from "@/components/admin/session-workflow-shared";

type CeremonyResponse = {
  ok: boolean;
  code: string;
  action: string;
  changed: boolean;
  lessonId: string;
  from: string | null;
  to: string | null;
  message: string;
  readiness: LessonReadinessSnapshot | null;
  publication: { id: string; segment: string; publishedAt: string } | null;
  /** Phase D — the override half of the outcome (only the open-override
   * endpoint returns it; `used` is true only when readiness was bypassed). */
  override: { used: boolean; reason: string; missing: string[] } | null;
  /** Phase 17 — the delivery half of the outcome (null when the ceremony
   * produced no live publication). Never read to judge PUBLICATION success. */
  notification: {
    ok: boolean;
    code: string;
    eligible: number;
    delivered: number;
    alreadyNotified: number;
    skippedPreference: number;
    skippedQuietHours: number;
    failedChunks: number[];
    message: string;
  } | null;
};

/** Phase 17 — the Open-dialog confirmation numbers (server-derived,
 *  preference-aware: `pending` is what a run would insert RIGHT NOW). */
type RecipientsPreview = {
  eligible: number;
  alreadyNotified: number;
  pending: number;
  deliverableNow: number;
  skippedPreferenceNow: number;
  skippedQuietHoursNow: number;
  notifiedCount: number;
  publication: { id: string; segment: string; publishedAt: string } | null;
};

async function fetchRecipientsPreview(
  lessonId: string
): Promise<RecipientsPreview | null> {
  const res = await fetchJson<RecipientsPreview>(
    `/api/admin/lessons/${encodeURIComponent(lessonId)}/recipients`
  );
  return res.ok ? res.data : null;
}

function segmentLabelKey(scope: string): string {
  const s = String(scope || "").toUpperCase();
  if (s === "ARABIC") return "admin.491";
  if (s === "LANGUAGE") return "admin.492";
  return "admin.490";
}

async function runCeremony(
  lessonId: string,
  action: "open" | "mark-ready" | "unpublish"
): Promise<
  | { ok: true; data: CeremonyResponse }
  | { ok: false; status: number; error: string; data: Partial<CeremonyResponse> | null }
> {
  return fetchJson<CeremonyResponse>(
    `/api/admin/lessons/${encodeURIComponent(lessonId)}/${action}`,
    { method: "POST" }
  );
}

// ---------------------------------------------------------------------------
// OPEN — the publishing ceremony
// ---------------------------------------------------------------------------

export function OpenSessionDialog({
  open,
  onOpenChange,
  detail,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  detail: AdminSessionDetail;
  /** Refresh the detail screen (fresh readiness + status + history). */
  onDone: () => void;
}) {
  const tr = useT();
  const [confirming, setConfirming] = React.useState(false);
  // Live checklist: starts as the detail snapshot, replaced by the ceremony
  // response when the server judges with fresher rows (409 path). Reset on
  // the closed→open transition (render-time adjustment — the sanctioned
  // alternative to syncing state inside an effect).
  const [liveReadiness, setLiveReadiness] = React.useState<LessonReadinessSnapshot>(
    detail.readiness
  );
  // Phase 17 — the server-derived recipient preview. `null` = not loaded,
  // "error" = the preview endpoint refused; the ceremony remains the judge
  // either way (the preview never gates the Open button).
  const [preview, setPreview] = React.useState<RecipientsPreview | null | "error">(null);
  // Phase D — emergency override state. The override is a MODE of this
  // dialog: a strong warning + the missing requirements + a required reason,
  // never a silent bypass. All of it resets on the closed→open transition.
  const [overrideMode, setOverrideMode] = React.useState(false);
  const [overrideReason, setOverrideReason] = React.useState("");
  const [overrideError, setOverrideError] = React.useState<string | null>(null);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setLiveReadiness(detail.readiness);
      // Reset on the closed→open transition together with the checklist
      // (render-time adjustment — never a synchronous setState-in-effect).
      setPreview(null);
      setOverrideMode(false);
      setOverrideReason("");
      setOverrideError(null);
    }
  }

  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    fetchRecipientsPreview(detail.id)
      .then((data) => {
        if (alive) setPreview(data ?? "error");
      })
      .catch(() => {
        if (alive) setPreview("error");
      });
    return () => {
      alive = false;
    };
  }, [open, detail.id]);

  const confirm = async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      const res = await runCeremony(detail.id, "open");
      if (res.ok) {
        // Phase 17 — the delivery half of the outcome. Publication success
        // was already decided by the ceremony; these toasts report WHO got
        // the NEW_LESSON row and any suppressed/partial remainder.
        const n = res.data.notification;
        if (res.data.code === "NO_OP_ALREADY_IN_STATE") {
          // Idempotent replay: nothing was published by THIS call — say so.
          toast.info(tr("admin.392"));
          if (n && n.code === "ALREADY_DELIVERED") {
            toast.info(tr("admin.501"));
          } else if (n && n.delivered > 0) {
            toast.success(tr("admin.498", { p1: n.delivered }));
          }
        } else if (n && n.delivered > 0) {
          toast.success(tr("admin.498", { p1: n.delivered }));
        } else {
          toast.success(tr("admin.391"));
        }
        if (n && n.code === "EMITTED_PARTIAL") {
          // Partial delivery: the publication is LIVE (say so explicitly) and
          // retrying the same Open is the documented resume path. Keep the
          // dialog open so the operator can re-confirm immediately.
          toast.error(tr("admin.500", { p1: n.delivered, p2: n.delivered + Math.max(0, previewNotNull(preview)?.pending ?? 0) }));
          onDone();
          return;
        }
        if (n && (n.skippedPreference > 0 || n.skippedQuietHours > 0)) {
          toast.info(tr("admin.499", { p1: n.skippedPreference, p2: n.skippedQuietHours }));
        }
        onOpenChange(false);
        onDone();
        return;
      }
      if (res.data?.readiness) setLiveReadiness(res.data.readiness as LessonReadinessSnapshot);
      if (res.status === 409 && res.data?.code === "READINESS_BLOCKED") {
        // Phase D — the server refused with the LIVE checklist. Keep the
        // dialog open: the admin now sees exactly what is missing and can
        // take the (explicit, audited) emergency path if they really must.
        toast.error(tr("admin.403"));
        onDone();
        return;
      }
      toast.error(serverErrorText(tr, res.error));
      onDone();
    } finally {
      setConfirming(false);
    }
  };

  // Phase D — the emergency override confirmation. The SERVER re-validates
  // the reason and re-checks readiness; the client-side guard is only a
  // first line (and an a11y hint), never the authority.
  const confirmOverride = async () => {
    if (confirming) return;
    const reason = overrideReason.trim();
    if (!reason) {
      setOverrideError(tr("admin.605"));
      return;
    }
    setConfirming(true);
    setOverrideError(null);
    try {
      const res = await fetchJson<CeremonyResponse>(
        `/api/admin/lessons/${encodeURIComponent(detail.id)}/open-override`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }
      );
      if (res.ok) {
        if (res.data.code === "NO_OP_ALREADY_IN_STATE") {
          toast.info(tr("admin.392"));
        } else {
          toast.success(tr("admin.602"));
          toast.info(tr("admin.624"));
        }
        onOpenChange(false);
        onDone();
        return;
      }
      if (res.data?.readiness) {
        setLiveReadiness(res.data.readiness as LessonReadinessSnapshot);
      }
      if (res.status === 400) {
        // OVERRIDE_REASON_REQUIRED / OVERRIDE_REASON_TOO_LONG — the server
        // rejected the warrant itself; the reason field is where the fix is.
        setOverrideError(tr("admin.605"));
        return;
      }
      toast.error(serverErrorText(tr, res.error));
      onDone();
    } finally {
      setConfirming(false);
    }
  };

  const readinessBlocked = !liveReadiness.canBeReady;
  const archived = String(detail.curriculumStatus).toUpperCase() === "ARCHIVED";
  // The emergency path exists ONLY for blocked, non-archived sessions — and
  // only an admin ever sees this dialog's actions.
  const canOverride = readinessBlocked && !archived;
  const missingItems = liveReadiness.items.filter(
    (i) => i.required && i.state !== "OK"
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* PHASE D SCROLL FIX — the panel is a bounded flex column: header and
          footer are SHRINK-0 (always reachable), and ONLY the middle region
          scrolls (`flex-1 min-h-0 overflow-y-auto`). The previous nested
          scroll-area component + unbounded content could push the footer
          past the viewport on small laptop/mobile heights; this layout
          cannot — the dialog itself is capped at `100dvh - 2rem` and
          everything taller than the middle region scrolls inside it. */}
      <DialogContent className="sm:max-w-xl max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>{tr("admin.389")}</DialogTitle>
          <DialogDescription>{DetailTitle(detail)}</DialogDescription>
        </DialogHeader>

        <div
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain pe-2"
          data-testid="open-dialog-scroll-region"
        >
          {overrideMode ? (
            /* ---------------- EMERGENCY OVERRIDE PANEL (Phase D) --------- */
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <div className="flex items-center gap-2 text-sm font-bold text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {tr("admin.596")}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed">{tr("admin.597")}</p>
              </div>

              <div
                className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
                data-testid="open-override-missing"
              >
                <div className="text-xs font-semibold text-destructive">
                  {tr("admin.603")}
                </div>
                <ul className="mt-2 space-y-1.5">
                  {missingItems.map((item) => (
                    <li key={item.key} className="text-sm">
                      <span className="font-semibold">
                        {tr(READINESS_LABELS[item.key] || "admin.455")}
                      </span>
                      {readinessReasonText(tr, item.code) && (
                        <span className="text-muted-foreground">
                          {" — "}
                          {readinessReasonText(tr, item.code)}
                        </span>
                      )}
                    </li>
                  ))}
                  {liveReadiness.blocking.includes("CURRICULUM_ARCHIVED") && (
                    <li className="text-sm">{tr("admin.623")}</li>
                  )}
                </ul>
              </div>

              <div className="grid gap-1.5">
                <Label htmlFor="open-override-reason" className="text-sm font-semibold">
                  {tr("admin.598")}
                </Label>
                <Textarea
                  id="open-override-reason"
                  value={overrideReason}
                  onChange={(e) => {
                    setOverrideReason(e.target.value);
                    if (overrideError) setOverrideError(null);
                  }}
                  placeholder={tr("admin.599")}
                  rows={3}
                  maxLength={1000}
                  disabled={confirming}
                  aria-invalid={!!overrideError}
                  aria-describedby="open-override-reason-error"
                />
                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span id="open-override-reason-error" role="alert" className="text-destructive">
                    {overrideError ?? ""}
                  </span>
                  <span dir="ltr">{overrideReason.length}/1000</span>
                </div>
              </div>

              <div>
                <div className="mb-1.5 text-xs font-semibold text-muted-foreground">
                  {tr("admin.384")}
                </div>
                <ReadinessChecklist readiness={liveReadiness} compact />
              </div>
            </div>
          ) : (
            /* ---------------- NORMAL OPEN PANEL -------------------------- */
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <StatusBadge status={detail.status} />
                <TrackScopeBadge scope={detail.trackScope} />
                <CurriculumBadge value={detail.curriculumStatus} />
                <Badge
                  variant="outline"
                  className={
                    readinessBlocked
                      ? "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"
                      : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                  }
                >
                  {readinessBlocked ? tr("admin.414") : tr("admin.413")}
                </Badge>
              </div>
              <div className="grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">{tr("admin.399")}</div>
                  <div className="font-semibold">{tr(segmentLabelKey(detail.trackScope))}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">{tr("admin.441")}</div>
                  <div className="font-mono text-sm" dir="ltr">
                    {detail.readiness.trackScope}
                  </div>
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs font-semibold text-muted-foreground">{tr("admin.400")}</div>
                <p className="mt-1 text-sm">{tr("admin.401")}</p>
              </div>
              {/* Phase 17 — server-derived recipient preview: the SAME
                  derivation the fan-out delivers to (course × trackScope ×
                  active), rendered read-only. Never gates the ceremony. */}
              <div className="rounded-lg border p-3" data-testid="open-recipients-preview">
                <div className="text-xs font-semibold text-muted-foreground">
                  {tr("admin.494")}
                </div>
                {preview === null ? (
                  <p className="mt-1 text-sm text-muted-foreground">{tr("admin.502")}</p>
                ) : preview === "error" ? (
                  <p className="mt-1 text-sm text-muted-foreground">{tr("admin.505")}</p>
                ) : (
                  <div className="mt-1.5 grid gap-1.5 text-sm sm:grid-cols-3">
                    <div>
                      <div className="text-xs text-muted-foreground">{tr("admin.399")}</div>
                      <div className="font-semibold">
                        {preview.eligible === 0
                          ? tr("admin.496")
                          : tr("admin.495", { p1: preview.eligible })}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">{tr("admin.503", { p1: preview.pending })}</div>
                      <div className="font-semibold">
                        {tr("admin.497", { p1: preview.alreadyNotified })}
                      </div>
                      {preview.skippedPreferenceNow + preview.skippedQuietHoursNow > 0 && (
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          {tr("admin.499", { p1: preview.skippedPreferenceNow, p2: preview.skippedQuietHoursNow })}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        {tr("admin.504", { p1: preview.notifiedCount })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
              <div>
                <div className="mb-1.5 text-xs font-semibold text-muted-foreground">
                  {tr("admin.384")}
                </div>
                <ReadinessChecklist readiness={liveReadiness} compact />
              </div>
            </div>
          )}
        </div>

        {/* Phase D — footer actions: pinned at the bottom of the bounded
            panel, ALWAYS reachable regardless of how long the readiness
            detail list above is. */}
        <DialogFooter className="shrink-0 gap-2 flex-wrap">
          {overrideMode ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setOverrideMode(false);
                  setOverrideError(null);
                }}
                disabled={confirming}
              >
                {tr("admin.604")}
              </Button>
              <Button
                variant="destructive"
                onClick={confirmOverride}
                disabled={confirming || overrideReason.trim().length === 0}
                data-testid="open-override-confirm"
              >
                {confirming && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                {confirming ? tr("admin.601") : tr("admin.600")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
                {tr("admin.288")}
              </Button>
              {canOverride && (
                <Button
                  variant="outline"
                  className="border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
                  onClick={() => setOverrideMode(true)}
                  disabled={confirming}
                  data-testid="open-anyway-button"
                >
                  <AlertTriangle className="w-4 h-4 me-1.5" />
                  {tr("admin.595")}
                </Button>
              )}
              <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2 w-full sm:w-auto">
                <Button
                  onClick={confirm}
                  disabled={confirming || readinessBlocked}
                  className="w-full sm:w-auto"
                  data-testid="open-normal-confirm"
                >
                  {confirming && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                  {confirming ? tr("admin.390") : tr("admin.402")}
                </Button>
              </div>
            </>
          )}
        </DialogFooter>

        {/* Context hints under the footer (never block the actions). */}
        {!overrideMode && readinessBlocked && !archived && (
          <p className="shrink-0 text-[11px] text-muted-foreground">{tr("admin.607")}</p>
        )}
        {!overrideMode && !readinessBlocked && detail.status === "DRAFT" && (
          <p className="shrink-0 text-[11px] text-muted-foreground">{tr("admin.606")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Phase D — checklist requirement labels reused by the override panel. */
const READINESS_LABELS: Record<string, string> = {
  VIDEO: "admin.380",
  PDF: "admin.381",
  QUIZ: "admin.382",
  HOMEWORK: "admin.383",
};

function DetailTitle(detail: AdminSessionDetail): string {
  const name = pickAuto(detail.titleAr, detail.title);
  return detail.officialCode ? `${detail.officialCode} · ${name}` : name;
}

/** Narrow the tri-state preview for arithmetic (presentation only). */
function previewNotNull(
  preview: RecipientsPreview | null | "error"
): RecipientsPreview | null {
  return preview && preview !== "error" ? preview : null;
}

// ---------------------------------------------------------------------------
// MARK READY — DRAFT → READY staging
// ---------------------------------------------------------------------------

export function MarkReadyDialog({
  open,
  onOpenChange,
  detail,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  detail: AdminSessionDetail;
  onDone: () => void;
}) {
  const tr = useT();
  const [confirming, setConfirming] = React.useState(false);

  const confirm = async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      const res = await runCeremony(detail.id, "mark-ready");
      if (res.ok) {
        toast.success(
          res.data.code === "NO_OP_ALREADY_IN_STATE" ? tr("admin.344") : tr("admin.388")
        );
        onOpenChange(false);
        onDone();
        return;
      }
      if (res.status === 409 && res.data?.code === "READINESS_BLOCKED") {
        const blocking = (res.data.readiness?.blocking || []).join(", ");
        toast.error(`${tr("admin.403")}: ${blocking || ""}`);
      } else {
        toast.error(serverErrorText(tr, res.error));
      }
      onDone();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* PHASE D SCROLL FIX — same bounded flex column as the Open dialog:
          fixed header/footer, scrollable middle only. */}
      <DialogContent className="sm:max-w-xl max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>{tr("admin.386")}</DialogTitle>
          <DialogDescription>{DetailTitle(detail)}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pe-2">
          <ReadinessChecklist readiness={detail.readiness} compact />
        </div>
        <DialogFooter className="shrink-0 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            {tr("admin.288")}
          </Button>
          <Button onClick={confirm} disabled={confirming || !detail.readiness.canBeReady}>
            {confirming && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {confirming ? tr("admin.387") : tr("admin.386")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// UNPUBLISH — PUBLISHED → READY withdrawal
// ---------------------------------------------------------------------------

export function UnpublishDialog({
  open,
  onOpenChange,
  detail,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  detail: AdminSessionDetail;
  onDone: () => void;
}) {
  const tr = useT();
  const [confirming, setConfirming] = React.useState(false);

  const confirm = async () => {
    if (confirming) return;
    setConfirming(true);
    try {
      const res = await runCeremony(detail.id, "unpublish");
      if (!res.ok) {
        toast.error(serverErrorText(tr, res.error));
        onDone();
        return;
      }
      toast.success(tr("admin.395"));
      onOpenChange(false);
      onDone();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tr("admin.243")}</DialogTitle>
          <DialogDescription>
            {DetailTitle(detail)} — {tr("admin.493")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={detail.status} />
          <TrackScopeBadge scope={detail.trackScope} />
          {detail.publication && (
            <Badge variant="outline" className="text-[10px]">
              {tr("admin.439")}:{" "}
              {new Date(detail.publication.publishedAt).toLocaleDateString("en-GB", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{tr("admin.396")}</p>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            {tr("admin.288")}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={confirming}>
            {confirming && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {confirming ? tr("admin.394") : tr("admin.243")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
