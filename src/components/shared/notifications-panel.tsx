"use client";

// CodeMind Academy — SHARED notifications panel (post-launch fix).
//
// ONE implementation of the notification list for every non-admin role
// (Student / Teacher / Parent). Before this component existed the bell in the
// dashboard shell sent EVERY non-admin role to the `student-notifications`
// view — which only the Student dashboard rendered. Teacher and Parent
// sessions clicked the bell and were handed their own home dashboard, so the
// unread badge was right but the notifications themselves never displayed
// (the reported production symptom).
//
// BEHAVIOR CONTRACT
// =================
//  * ONE fetch on mount (`/api/notifications`, newest 50, scoped to the
//    caller server-side). No polling here — the shell bell already refreshes
//    the count, and after a read action this panel emits
//    `cm:notifications-changed` so the badge updates immediately.
//  * Each row shows: title, short message, relative time, unread/read state
//    (unread rows are visually distinct + carry an accessible state label).
//  * Clicking a row ALWAYS marks it read (and refreshes the badge). A row is
//    never "clickable and does nothing":
//      - notification WITH a deep link whose target view is legal for the
//        CURRENT role → an "Open" button navigates (the destination's own
//        API re-authorizes server-side — the link is never authorization);
//      - notification WITHOUT a deep link, or whose target is not legal for
//        this role (legacy strings, student-only links for a teacher/parent)
//        → purely informational: the content is already on screen, clicking
//        reads it, nothing navigates to nowhere, no error is thrown.
//  * Loading / empty / error states, mark-all-read, accessible buttons,
//    RTL-aware (logical properties only), mobile responsive.

import * as React from "react";
import { useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import { navigateDeepLink, resolveDeepLinkForRole } from "@/lib/deep-link";
import { SessionLinkActions } from "@/components/shared/session-link-actions";
import { isViewForRole } from "@/lib/view-roles";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  Bell,
  CheckCircle2,
  ChevronLeft,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";

/** The shell bell listens for this to refresh the unread badge instantly. */
export const NOTIFICATIONS_CHANGED_EVENT = "cm:notifications-changed";

export function emitNotificationsChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CHANGED_EVENT));
  }
}

type NotifItem = {
  id: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  link: string | null;
  /** Phase F — the STRUCTURED session payload. When set, the row renders the
   *  Join / Copy-link actions, resolved server-side and only inside the join
   *  window (the meeting URL is never carried in the notification itself). */
  sessionId?: string | null;
  createdAt: string;
};

/** Phase F session events that carry the join/copy actions. */
const SESSION_LINK_TYPES = new Set([
  "SESSION_LINK",
  "SESSION_SCHEDULED",
  "SESSION_RESCHEDULED",
  "SESSION_CANCELLED",
]);

function relativeTime(dateStr: string, t: (k: string, p?: Record<string, unknown>) => string): string {
  const d = new Date(dateStr).getTime();
  if (Number.isNaN(d)) return "";
  const diffMin = Math.floor((Date.now() - d) / 60000);
  if (diffMin < 1) return t("notif.now");
  if (diffMin < 60) return t("notif.minAgo", { p1: diffMin });
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return t("notif.hourAgo", { p1: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("notif.dayAgo", { p1: days });
  const locale = useApp.getState().locale === "en" ? "en-GB" : "ar-EG";
  return new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(dateStr));
}

export function NotificationsPanel({
  homeView,
  title,
  showBack = true,
  className,
}: {
  /** View to return to (each role's dashboard home). */
  homeView: "student-dashboard" | "teacher-dashboard" | "parent-dashboard" | "admin-notifications";
  title?: string;
  /** Admin center embeds the panel without a back bar. */
  showBack?: boolean;
  className?: string;
}) {
  const t = useT();
  const user = useApp((s) => s.user);
  const setView = useApp((s) => s.setView);
  const [items, setItems] = React.useState<NotifItem[] | null>(null);
  const [error, setError] = React.useState(false);

  const reload = React.useCallback(() => {
    setError(false);
    fetch("/api/notifications")
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => setItems(d?.notifications || d?.items || []))
      .catch(() => {
        setError(true);
        setItems(null);
      });
  }, []);

  // One intentional fetch on open (the view unmounts when you leave, so
  // re-entering always re-fetches). No interval, no refetch loops.
  React.useEffect(() => {
    setItems(null);
    reload();
  }, [reload]);

  const markRead = async (id: string) => {
    // Optimistic: the badge must drop the moment the user acts.
    setItems((prev) =>
      prev ? prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)) : prev
    );
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    emitNotificationsChanged();
  };

  const markAll = async () => {
    setItems((prev) => (prev ? prev.map((n) => ({ ...n, isRead: true })) : prev));
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markAllRead: true }),
    }).catch(() => {});
    toast.success(t("notif.markedAll"));
    emitNotificationsChanged();
  };

  const unreadCount = items?.filter((n) => !n.isRead).length ?? 0;

  /**
   * Deep links may only offer navigation when the target view is legal for
   * the CURRENT role — see src/lib/view-roles.ts. Every other link shape
   * (null, legacy strings like `student-homework`, a malformed value) is
   * treated as informational: the row still reads on click.
   */
  const targetViewFor = (n: NotifItem): string | null => {
    if (!user) return null;
    // Phase F: `live:` / `absence:` resolve per ROLE (student schedule,
    // teacher workspace, admin console, parent absences). Any other kind keeps
    // the historical student-first mapping.
    const target = resolveDeepLinkForRole(n.link, user.role);
    if (!target) return null;
    return isViewForRole(target.view, user.role) ? target.view : null;
  };

  const openNotification = (n: NotifItem) => {
    const view = targetViewFor(n);
    if (!view) return; // informational — the row click already read it
    if (!n.isRead) void markRead(n.id);
    // navigateDeepLink keeps the Phase 16 ORDER: setView first (which resets
    // navParam), setNavParam second — a `lesson:<id>` link must land on the
    // specific lesson, not the list.
    navigateDeepLink(n.link, useApp.getState());
  };

  return (
    <div className={`space-y-4 ${className || ""}`}>
      <div className="flex items-center justify-between gap-2">
        {showBack ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setView(homeView as never)}
          >
            <ArrowLeft className="w-4 h-4 ms-1.5 flip-rtl" />
            {t("notif.back")}
          </Button>
        ) : (
          <span />
        )}
        <h1 className="text-lg font-bold">
          {title || t("notif.title")}
          {unreadCount > 0 && (
            <Badge variant="secondary" className="ms-2 text-[10px]">
              {t("notif.unreadCount", { p1: unreadCount })}
            </Badge>
          )}
        </h1>
        <div className="min-w-20 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={markAll}
            disabled={!items || items.length === 0 || unreadCount === 0}
          >
            <CheckCircle2 className="w-4 h-4 ms-1.5" />
            {t("notif.markAll")}
          </Button>
        </div>
      </div>

      <Card className="glass">
        <CardContent className="p-0">
          {error ? (
            <div className="flex flex-col items-center justify-center py-10 gap-3">
              <div className="grid place-items-center w-10 h-10 rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <p className="text-sm font-medium">{t("notif.loadError")}</p>
              <Button size="sm" variant="outline" onClick={reload}>
                {t("notif.retry")}
              </Button>
            </div>
          ) : !items ? (
            <div className="p-6 space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <div className="grid place-items-center w-10 h-10 rounded-full bg-muted text-muted-foreground mb-2">
                <Bell className="w-5 h-5" />
              </div>
              <p className="text-sm font-semibold">{t("notif.empty")}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {t("notif.emptyHint")}
              </p>
            </div>
          ) : (
            /*
              BUG T — "All Notifications" vertical overflow.
              *
              * The previous wrapper bounded ONLY the Radix root
              * (`max-h-[70vh] overflow-y-auto`). The root is `overflow-hidden`
              * (see ui/scroll-area.tsx) and the real scroller is the inner
              * Viewport, so the class was inert: with more rows than fitted,
              * the list was clipped, the bottom rows' actions were
              * unreachable, and the wheel scrolled the PAGE behind the panel
              * instead (the reported symptom).
              *
              * The fix is the house pattern already used by
              * session-open-dialog.tsx:
              *   * a height that is bounded by the VIEWPORT, not by a magic
              *     percentage — `min(60dvh, calc(100dvh - 15rem))` keeps the
              *     header, the bell and the page chrome visible, so the list
              *     can never be taller than the screen (no clipped bottom, on
              *     a laptop or a short desktop window);
              *   * `overscroll-contain`, so reaching the end of the list does
              *     not trap or hijack the page scroll (no body-scroll trap);
              *   * `min-h-0` in the flex chain and bottom padding on the list,
              *     so the LAST row's action button is fully reachable and is
              *     never cut by the scrollbar/corner of the Radix root.
              */
            <ScrollArea className="max-h-[min(60dvh,calc(100dvh-15rem))] min-h-0 overscroll-contain">
              <ul className="pb-1">
                {items.map((n) => {
                  const targetView = targetViewFor(n);
                  return (
                    <li
                      key={n.id}
                      className={`flex gap-3 px-4 py-3 border-b border-border/60 last:border-0 transition-colors ${
                        n.isRead ? "" : "bg-primary/5"
                      }`}
                    >
                      <div
                        className={`grid place-items-center w-8 h-8 rounded-full shrink-0 ${
                          n.isRead
                            ? "bg-muted text-muted-foreground"
                            : "bg-primary text-primary-foreground"
                        }`}
                      >
                        <Bell className="w-4 h-4" />
                      </div>
                      <button
                        type="button"
                        onClick={() => void markRead(n.id)}
                        aria-label={`${n.title} — ${
                          n.isRead ? t("notif.read") : t("notif.unread")
                        }`}
                        className="flex-1 min-w-0 text-start rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <div className="flex items-start gap-2">
                          <span className="text-sm font-semibold break-words min-w-0">
                            {n.title}
                          </span>
                          {!n.isRead && (
                            <span
                              className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5"
                              aria-hidden="true"
                            />
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground break-words">
                          {n.message}
                        </div>
                        <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                          {relativeTime(n.createdAt, t)}
                        </div>
                      </button>
                      {/* Phase F — a session notification is STRUCTURED, not a
                          text blob: the student gets the real join/copy
                          actions, gated server-side by the join window. */}
                      {n.sessionId && SESSION_LINK_TYPES.has(n.type) && (
                        <div className="shrink-0 self-center">
                          <SessionLinkActions
                            sessionId={n.sessionId}
                            status={n.type === "SESSION_CANCELLED" ? "CANCELLED" : "SCHEDULED"}
                            state={{ allowed: false, denialCode: null }}
                            size="compact"
                          />
                        </div>
                      )}
                      {targetView && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs shrink-0 self-center"
                          onClick={() => openNotification(n)}
                        >
                          {t("notif.open")}
                          <ChevronLeft className="w-3.5 h-3.5 flip-rtl" />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
