"use client";

// Phase H — progression override manager (Admin only).
//
// An override is an audited, expirable, revocable EXCEPTION to the canonical
// progression engine: a named student may open a named lesson even though the
// sequential chain would refuse. It NEVER writes an academic fact (no quiz
// pass, no submission, no video row, no COMPLETED rewrite) and NEVER crosses
// the track boundary — the server enforces all of that; this panel only
// collects the mandatory reason (+ optional expiry) and renders the audit
// trail (who granted, when, until when, who revoked).

import * as React from "react";
import { useT } from "@/lib/i18n";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { KeyRound, Search, X } from "lucide-react";

type OverrideRow = {
  id: string;
  lessonId: string;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  active: boolean;
  lesson: { id: string; title: string; titleAr: string; officialCode: string | null } | null;
  grantedBy: { id: string; name: string | null };
  revokedBy: { id: string; name: string | null } | null;
};

type LessonOption = {
  id: string;
  title: string;
  titleAr: string;
  officialCode: string | null;
  status: string;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export function ProgressionOverrideSection({ studentId }: { studentId: string }) {
  const tr = useT();
  const [rows, setRows] = React.useState<OverrideRow[] | null>(null);
  const [lessons, setLessons] = React.useState<LessonOption[]>([]);
  const [search, setSearch] = React.useState("");
  const [lessonId, setLessonId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [granting, setGranting] = React.useState(false);
  const [arming, setArming] = React.useState<string | null>(null);
  const [revokeNote, setRevokeNote] = React.useState("");
  const [revoking, setRevoking] = React.useState(false);

  const reload = React.useCallback(async () => {
    const res = await fetch(
      `/api/admin/progression-overrides?studentId=${encodeURIComponent(studentId)}`
    );
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || "err");
    setRows((j.overrides ?? []) as OverrideRow[]);
  }, [studentId]);

  // Initial load lives INSIDE the effect (async callbacks may set state;
  // calling the `reload` setter synchronously trips set-state-in-effect).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/progression-overrides?studentId=${encodeURIComponent(studentId)}`
        );
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || "err");
        if (!cancelled) setRows((j.overrides ?? []) as OverrideRow[]);
      } catch (e) {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "err");
          setRows([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  // Grantable lessons are PUBLISHED sessions; the server re-validates the
  // course + track + lifecycle rules, so a stale option can never over-grant.
  React.useEffect(() => {
    fetch("/api/admin/lessons?status=PUBLISHED&pageSize=200")
      .then((r) => r.json())
      .then((j) => setLessons((j.lessons ?? []) as LessonOption[]))
      .catch(() => {});
  }, []);

  const picked = lessons.find((l) => l.id === lessonId) ?? null;
  const q = search.trim().toLowerCase();
  const matches =
    q.length === 0
      ? []
      : lessons
          .filter((l) =>
            [l.titleAr, l.title, l.officialCode ?? ""]
              .join(" ")
              .toLowerCase()
              .includes(q)
          )
          .slice(0, 8);

  const grant = async () => {
    if (!lessonId) {
      toast.error(tr("phaseh.ovPickLesson"));
      return;
    }
    if (reason.trim().length < 3) {
      toast.error(tr("phaseh.ovReasonShort"));
      return;
    }
    setGranting(true);
    try {
      const res = await fetch("/api/admin/progression-overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          lessonId,
          reason: reason.trim(),
          ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "err");
      toast.success(tr("phaseh.ovGranted"));
      setLessonId("");
      setSearch("");
      setReason("");
      setExpiresAt("");
      await reload();
    } catch (e: any) {
      toast.error(e.message || "err");
    } finally {
      setGranting(false);
    }
  };

  const revoke = async (id: string) => {
    setRevoking(true);
    try {
      const res = await fetch(`/api/admin/progression-overrides/${id}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(revokeNote.trim() ? { reason: revokeNote.trim() } : {}),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || "err");
      toast.success(tr("phaseh.ovRevoked"));
      setArming(null);
      setRevokeNote("");
      await reload();
    } catch (e: any) {
      toast.error(e.message || "err");
    } finally {
      setRevoking(false);
    }
  };

  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4" />
        <div>
          <div className="text-sm font-semibold">{tr("phaseh.ovTitle")}</div>
          <div className="text-xs text-muted-foreground">{tr("phaseh.ovSub")}</div>
        </div>
      </div>

      {/* Grant form */}
      <div className="space-y-2">
        <div>
          <Label>{tr("phaseh.ovLesson")}</Label>
          {picked ? (
            <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
              <span className="flex-1 truncate">
                {picked.titleAr || picked.title}
                {picked.officialCode ? ` (${picked.officialCode})` : ""}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setLessonId("");
                  setSearch("");
                }}
                aria-label="clear"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={tr("phaseh.ovSearch")}
                />
              </div>
              {matches.length > 0 && (
                <div className="mt-1 max-h-40 overflow-auto rounded-md border text-sm">
                  {matches.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      className="block w-full px-2 py-1.5 text-left hover:bg-muted"
                      onClick={() => {
                        setLessonId(l.id);
                        setSearch("");
                      }}
                    >
                      <span className="block truncate">{l.titleAr || l.title}</span>
                      {l.officialCode && (
                        <span className="block text-xs text-muted-foreground">{l.officialCode}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div>
          <Label>{tr("phaseh.ovReason")}</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={tr("phaseh.ovReasonPh")}
            rows={2}
          />
        </div>
        <div>
          <Label>{tr("phaseh.ovExpires")}</Label>
          <Input
            type="datetime-local"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
        <Button size="sm" onClick={grant} disabled={granting}>
          {granting ? tr("phaseh.ovGranting") : tr("phaseh.ovGrant")}
        </Button>
      </div>

      {/* Audit list */}
      <div className="space-y-2">
        {rows === null && (
          <div className="text-xs text-muted-foreground">…</div>
        )}
        {rows !== null && rows.length === 0 && (
          <div className="text-xs text-muted-foreground">{tr("phaseh.ovEmpty")}</div>
        )}
        {(rows ?? []).map((r) => {
          const expired =
            !r.revokedAt && r.expiresAt ? new Date(r.expiresAt).getTime() < Date.now() : false;
          return (
            <div key={r.id} className="rounded-md border px-2 py-1.5 text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="flex-1 truncate font-medium">
                  {r.lesson ? r.lesson.titleAr || r.lesson.title : r.lessonId}
                </span>
                {r.revokedAt ? (
                  <Badge variant="secondary">{tr("phaseh.ovRevokedState")}</Badge>
                ) : expired ? (
                  <Badge variant="outline">{tr("phaseh.ovExpiredState")}</Badge>
                ) : (
                  <Badge>{tr("phaseh.ovActive")}</Badge>
                )}
              </div>
              <div className="text-muted-foreground">
                {r.reason} — {tr("phaseh.ovBy")} {r.grantedBy.name ?? r.grantedBy.id} ·{" "}
                {fmtDate(r.createdAt)} · {tr("phaseh.ovUntil")}{" "}
                {r.expiresAt ? fmtDate(r.expiresAt) : tr("phaseh.ovNoExpiry")}
              </div>
              {r.revokedAt && (
                <div className="text-muted-foreground">
                  {tr("phaseh.ovRevokedState")}: {fmtDate(r.revokedAt)}
                  {r.revokedBy ? ` — ${tr("phaseh.ovBy")} ${r.revokedBy.name ?? r.revokedBy.id}` : ""}
                  {r.revokeReason ? ` — ${r.revokeReason}` : ""}
                </div>
              )}
              {!r.revokedAt && !expired && (
                <div>
                  {arming === r.id ? (
                    <div className="flex items-center gap-2">
                      <Input
                        value={arming === r.id ? revokeNote : ""}
                        onChange={(e) => setRevokeNote(e.target.value)}
                        placeholder={tr("phaseh.ovReasonPh")}
                        className="h-8 text-xs"
                      />
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={revoking}
                        onClick={() => revoke(r.id)}
                      >
                        {revoking ? tr("phaseh.ovRevoking") : tr("phaseh.ovRevoke")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setArming(null);
                          setRevokeNote("");
                        }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setArming(r.id)}>
                      {tr("phaseh.ovRevoke")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
