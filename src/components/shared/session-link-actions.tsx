// CodeMind Academy — the ONE join/copy control for a LiveSession (Phase F).
//
// WHY A COMPONENT AND NOT A LINK
// ==============================
// The meeting URL is never rendered into the page: it is fetched from
// `GET /api/live-sessions/[id]/join` at the moment the student acts, and the
// server decides — from the actor's own rows and the join window — whether the
// link may be handed over at all. A student cannot obtain a link that the API
// refuses, no matter what the DOM says, and an ineligible reader can never
// find a URL in the notification payload either.
//
// STATES THE UI MUST SHOW (all of them, never a dead button):
//   * OPEN      → "انضم للحصة" (primary) + "نسخ الرابط"
//   * TOO_EARLY → disabled Join + the exact opening time
//   * ENDED     → disabled Join + "انتهت الحصة"
//   * CANCELLED → disabled Join + "الحصة ملغاة"
//   * NO LINK   → disabled Join + "لم يتم إضافة رابط الحصة بعد"
//   * error     → toast, button stays usable for a retry
//
// The copy action copies the RESOLVED url (fetched from the server), never a
// value handed to the client in advance.

"use client";

import * as React from "react";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Copy, ExternalLink, Loader2 } from "lucide-react";

export type JoinState = {
  allowed: boolean;
  denialCode?: string | null;
  opensAt?: string | null;
  closesAt?: string | null;
};

export type SessionLinkActionsProps = {
  sessionId: string;
  /** The server-computed join state for THIS viewer (from the list payload). */
  state: JoinState;
  status: string;
  /** `compact` renders icon-sized buttons for notification rows. */
  size?: "default" | "sm" | "compact";
  className?: string;
  onNavigated?: () => void;
};

function fmt(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function SessionLinkActions({
  sessionId,
  state,
  status,
  size = "default",
  className,
  onNavigated,
}: SessionLinkActionsProps) {
  const t = useT();
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const cancelled = status === "CANCELLED";
  const ended = status === "COMPLETED";
  const disabled = !state.allowed;

  const denialLabel = (): string => {
    if (cancelled) return t("live.join.cancelled");
    if (ended || state.denialCode === "SESSION_ENDED") return t("live.join.ended");
    if (state.denialCode === "LINK_NOT_SET") return t("live.join.noLink");
    if (state.denialCode === "TOO_EARLY") {
      const minutes = Math.max(
        1,
        Math.round((new Date(state.opensAt ?? Date.now()).getTime() - Date.now()) / 60000)
      );
      return t("live.join.tooEarly", { p1: minutes });
    }
    return t("live.join.noLink");
  };

  /** Fetch the authorized URL. Returns null (and toasts) on refusal. */
  const fetchUrl = async (): Promise<string | null> => {
    const res = await fetch(`/api/live-sessions/${sessionId}/join`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = String(body?.code ?? "");
      if (code === "TOO_EARLY") toast.error(t("live.join.tooEarly", { p1: 15 }));
      else if (code === "SESSION_ENDED") toast.error(t("live.join.ended"));
      else if (code === "SESSION_CANCELLED") toast.error(t("live.join.cancelled"));
      else if (code === "LINK_NOT_SET") toast.error(t("live.join.noLink"));
      else toast.error(t("live.join.error"));
      return null;
    }
    return typeof body?.url === "string" ? body.url : null;
  };

  const open = async () => {
    setBusy(true);
    try {
      const url = await fetchUrl();
      if (!url) return;
      onNavigated?.();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      toast.error(t("live.join.error"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    setBusy(true);
    try {
      const url = await fetchUrl();
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // Clipboard API can be unavailable (insecure context, permissions):
        // fall back to a temporary textarea so the action never silently fails.
        const area = document.createElement("textarea");
        area.value = url;
        area.setAttribute("readonly", "true");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      setCopied(true);
      onNavigated?.();
      toast.success(t("live.join.copied"));
      setTimeout(() => setCopied(false), 2500);
    } catch {
      toast.error(t("live.join.copyFailed"));
    } finally {
      setBusy(false);
    }
  };

  const compact = size === "compact";
  const small = size === "sm" || compact;
  const joinLabel = copied ? t("live.join.copied") : disabled ? denialLabel() : t("live.join.now");

  return (
    <div className={`flex items-center gap-2 flex-wrap ${className ?? ""}`}>
      <Button
        size={small ? "sm" : "default"}
        className={compact ? "h-7 px-2 text-xs" : undefined}
        onClick={open}
        disabled={busy || disabled}
        aria-disabled={busy || disabled}
        title={disabled ? denialLabel() : undefined}
      >
        {busy ? (
          <Loader2 className="w-3.5 h-3.5 ms-1.5 animate-spin" />
        ) : (
          <ExternalLink className={compact ? "w-3.5 h-3.5 ms-0" : "w-4 h-4 ms-1.5"} />
        )}
        {compact ? t("live.join.now") : joinLabel}
      </Button>
      {!compact && (
        <Button size={small ? "sm" : "default"} variant="outline" onClick={copy} disabled={busy || disabled}>
          <Copy className="w-4 h-4 ms-1.5" />
          {t("live.join.copy")}
        </Button>
      )}
      {disabled && !compact && (
        <span className="text-xs text-muted-foreground">{denialLabel()}</span>
      )}
      {!disabled && !compact && state.opensAt && status === "SCHEDULED" && (
        <span className="text-[11px] text-muted-foreground">
          {t("live.join.opensAt", { p1: fmt(state.opensAt) })}
        </span>
      )}
    </div>
  );
}

export default SessionLinkActions;
