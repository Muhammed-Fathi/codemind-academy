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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2 } from "lucide-react";
import {
  CurriculumBadge,
  ReadinessChecklist,
  StatusBadge,
  TrackScopeBadge,
  fetchJson,
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
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setLiveReadiness(detail.readiness);
      // Reset on the closed→open transition together with the checklist
      // (render-time adjustment — never a synchronous setState-in-effect).
      setPreview(null);
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
        const blocking = (res.data.readiness?.blocking || []).join(", ");
        toast.error(`${tr("admin.403")}: ${blocking || res.data.message || ""}`);
        onDone();
        return;
      }
      toast.error(serverErrorText(tr, res.error));
      onDone();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{tr("admin.389")}</DialogTitle>
          <DialogDescription>
            {DetailTitle(detail)}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[55vh] pe-2">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={detail.status} />
              <TrackScopeBadge scope={detail.trackScope} />
              <CurriculumBadge value={detail.curriculumStatus} />
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
        </ScrollArea>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            {tr("admin.288")}
          </Button>
          <Button onClick={confirm} disabled={confirming}>
            {confirming && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {confirming ? tr("admin.390") : tr("admin.402")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
      <DialogContent className="sm:max-w-xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{tr("admin.386")}</DialogTitle>
          <DialogDescription>{DetailTitle(detail)}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[50vh] pe-2">
          <ReadinessChecklist readiness={detail.readiness} compact />
        </ScrollArea>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            {tr("admin.288")}
          </Button>
          <Button onClick={confirm} disabled={confirming}>
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
