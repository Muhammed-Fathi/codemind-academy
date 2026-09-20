"use client";

// ============================================================
// CodeMind Academy — Admin: progression overrides (Phase H)
//
// The ONLY place a human can lift a progression boundary. Everything it shows
// comes from ONE evaluation — the same canonical engine the student's own
// screens read — so the console can never describe a boundary the student is
// not actually stopped by.
//
// The console is deliberately narrow on purpose:
//   * ADMIN only (the route re-checks the role server-side, and the authority
//     re-checks it again on every write);
//   * the reason is MANDATORY and is never pre-filled;
//   * the expiry is OPTIONAL and must be in the future;
//   * issuing an override creates NO academic fact — no quiz attempt, no
//     homework submission, no watch progress, and it never clears an absence
//     hold (the warning card says exactly that, in Arabic, before the form);
//   * revoking never deletes the row: the decision stays on the record.
//
// All spacing/alignment uses logical properties (ps-/pe-/ms-/me-/text-start)
// so the layout is correct in Arabic (RTL) and English (LTR) alike.
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useT, pickAuto } from "@/lib/i18n";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ShieldAlert,
  Search,
  UserRound,
  KeyRound,
  Ban,
  Loader2,
  CheckCircle2,
  Clock3,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Wire types (mirror src/app/api/admin/progression/overrides)
// ---------------------------------------------------------------------------

type StudentHit = {
  id: string;
  name: string;
  email: string;
  studentCode: string | null;
  schoolType: string | null;
  group: { id: string; name: string; course: { nameAr: string } | null } | null;
};

type LessonOption = {
  id: string;
  title: string;
  titleAr: string;
  order: number;
  officialCode: string | null;
  state: "LOCKED" | "UNLOCKED" | "COMPLETED" | null;
  reason: { code: string; text: string } | null;
};

type OverrideRow = {
  id: string;
  lessonId: string;
  courseId: string | null;
  reason: string;
  createdByUserId: string;
  createdAt: string | null;
  expiresAt: string | null;
  valid: boolean;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
};

type Console = {
  student: { id: string; name: string | null; email: string | null; courseId: string | null };
  overrides: OverrideRow[];
  actors: Record<string, string>;
  holds: { id: string; status: string; lessonId: string | null; sessionId: string; reviewStatus: string | null }[];
  lessons: LessonOption[];
  progression: {
    currentLessonId: string | null;
    boundary: { lessonId: string; reason: { code: string; text: string } } | null;
    hold: { holdId: string; status: string; active: boolean; blocks: boolean } | null;
    catchUp: { lessonId: string | null; satisfied: boolean } | null;
  } | null;
};

function fmtDateTime(value: string | null | undefined, tr: (k: string) => string) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return d.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return tr("admin.progression.noBoundary");
  }
}

/**
 * The three canonical states, mapped to their dictionary keys EXPLICITLY:
 * a runtime-built key would be invisible to the i18n audit, and a missing
 * Arabic string in an admin console is exactly what that audit exists to stop.
 */
const STATE_LABEL_KEYS: Record<string, string> = {
  LOCKED: "progression.state.locked",
  UNLOCKED: "progression.state.unlocked",
  COMPLETED: "progression.state.completed",
};

export function ProgressionOverridesView() {
  const tr = useT();

  const [term, setTerm] = React.useState("");
  const [hits, setHits] = React.useState<StudentHit[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const [consoleData, setConsoleData] = React.useState<Console | null>(null);
  const [loadingConsole, setLoadingConsole] = React.useState(false);

  const [lessonId, setLessonId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);

  // ---- student search (debounced, server-side, ADMIN-only endpoint) ----
  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setSearching(true);
      try {
        const r = await fetch(
          `/api/admin/students?search=${encodeURIComponent(term)}&pageSize=12`
        );
        const d = await r.json();
        if (cancelled) return;
        setHits(r.ok ? (d.students || []) : []);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    };
    const timer = setTimeout(run, term.trim() ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  // ---- the canonical console for the selected student ----
  //
  // There is deliberately NO effect here. Every load is triggered by an EVENT
  // (pick a student / issue / revoke), which is both the pattern React
  // recommends for data that depends on a user action and the reason this
  // component adds no `react-hooks/set-state-in-effect` violation. The token
  // guard makes a slow response for a previously selected student unable to
  // overwrite the current one.
  const loadToken = React.useRef(0);
  const loadConsole = async (studentId: string) => {
    const token = ++loadToken.current;
    setLoadingConsole(true);
    try {
      const r = await fetch(
        `/api/admin/progression/overrides?studentId=${encodeURIComponent(studentId)}`
      );
      const d = await r.json();
      if (token !== loadToken.current) return;
      setConsoleData(r.ok ? (d as Console) : null);
    } catch {
      if (token !== loadToken.current) return;
      setConsoleData(null);
    } finally {
      if (token === loadToken.current) setLoadingConsole(false);
    }
  };

  // Switching student clears the previous console and the in-flight form.
  const pickStudent = (id: string) => {
    setSelectedId(id);
    setConsoleData(null);
    setLessonId("");
    setReason("");
    setExpiresAt("");
    void loadConsole(id);
  };

  const issue = async () => {
    if (!selectedId) return;
    if (!lessonId) {
      toast.error(tr("admin.progression.studentRequired"));
      return;
    }
    if (!reason.trim()) {
      toast.error(tr("admin.progression.reasonRequired"));
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/admin/progression/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: selectedId,
          lessonId,
          reason: reason.trim(),
          // Empty string = "no expiry" (valid until revoked). The server
          // re-validates; the console never decides policy on its own.
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || tr("admin.001"));
        return;
      }
      toast.success(tr("admin.progression.created"));
      setReason("");
      setExpiresAt("");
      setLessonId("");
      await loadConsole(selectedId);
    } catch {
      toast.error(tr("admin.001"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    try {
      const r = await fetch(`/api/admin/progression/overrides/${id}/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || tr("admin.001"));
        return;
      }
      toast.success(tr("admin.progression.revoked"));
      if (selectedId) await loadConsole(selectedId);
    } catch {
      toast.error(tr("admin.001"));
    } finally {
      setRevokingId(null);
    }
  };

  const lessons = consoleData?.lessons ?? [];
  const lessonLabel = (id: string) => {
    const l = lessons.find((x) => x.id === id);
    if (!l) return id;
    const title = pickAuto(l.titleAr, l.title);
    return l.officialCode ? `${l.officialCode} · ${title}` : `${l.order}. ${title}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <div>
        <h2 className="text-xl font-bold">{tr("admin.progression.title")}</h2>
        <p className="text-xs text-muted-foreground">{tr("admin.progression.hint")}</p>
      </div>

      {/* The console writes nothing academic — said out loud, in Arabic. */}
      <Card className="border-amber-500/30 bg-amber-500/5 p-3">
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 w-4 h-4 shrink-0 text-amber-600" />
          <span>{tr("admin.progression.warning")}</span>
        </p>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* 1. Pick a student                                                */}
      {/* ---------------------------------------------------------------- */}
      <Card className="p-4">
        <CardHeader className="p-0 pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className="w-4 h-4" />
            {tr("admin.progression.student")}
          </CardTitle>
          <CardDescription className="text-xs">{tr("admin.progression.search")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0 space-y-3">
          <div className="relative">
            <Search className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-muted-foreground" />
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={tr("admin.progression.search")}
              className="ps-9"
              aria-label={tr("admin.progression.search")}
            />
          </div>

          {searching ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg" />
              ))}
            </div>
          ) : hits.length === 0 ? (
            <p className="text-center text-xs text-muted-foreground py-2">
              {tr("admin.progression.pickStudent")}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {hits.map((s) => {
                const active = s.id === selectedId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => pickStudent(s.id)}
                    className={`text-start rounded-lg border p-2.5 transition-colors ${
                      active
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/40 hover:bg-muted/40"
                    }`}
                  >
                    <div className="text-sm font-medium truncate">{s.name}</div>
                    <div className="text-[11px] text-muted-foreground truncate" dir="ltr">
                      {s.email}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {s.studentCode && (
                        <Badge variant="outline" className="text-[10px]" dir="ltr">
                          {s.studentCode}
                        </Badge>
                      )}
                      {s.group?.course?.nameAr && (
                        <Badge variant="outline" className="text-[10px]">
                          {s.group.course.nameAr}
                        </Badge>
                      )}
                      {s.schoolType && (
                        <Badge variant="outline" className="text-[10px]" dir="ltr">
                          {s.schoolType}
                        </Badge>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {loadingConsole && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      )}

      {!loadingConsole && !consoleData && selectedId && (
        <Card className="p-6">
          <p className="text-center text-sm text-muted-foreground">{tr("admin.001")}</p>
        </Card>
      )}

      {!loadingConsole && consoleData && (
        <>
          {/* ------------------------------------------------------------ */}
          {/* 2. What the canonical engine says                            */}
          {/* ------------------------------------------------------------ */}
          <Card className="p-4">
            <CardHeader className="p-0 pb-3">
              <CardTitle className="text-base">
                {consoleData.student.name || consoleData.student.email || consoleData.student.id}
              </CardTitle>
              <CardDescription className="text-xs" dir="ltr">
                {consoleData.student.email}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">{tr("admin.progression.boundary")}:</span>
                {consoleData.progression?.boundary ? (
                  <Badge variant="outline" className="border-destructive/40 text-destructive">
                    {lessonLabel(consoleData.progression.boundary.lessonId)}
                    {" · "}
                    {consoleData.progression.boundary.reason.text}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-emerald-500/40 text-emerald-600">
                    {tr("admin.progression.noBoundary")}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">{tr("admin.progression.current")}:</span>
                <span>
                  {consoleData.progression?.currentLessonId
                    ? lessonLabel(consoleData.progression.currentLessonId)
                    : "—"}
                </span>
              </div>
              {consoleData.holds.some((h) => h.status === "ACTIVE") && (
                <div className="flex items-center gap-2 text-xs text-amber-600">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  {tr("admin.progression.holdActive")}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ------------------------------------------------------------ */}
          {/* 3. Issue an override                                         */}
          {/* ------------------------------------------------------------ */}
          <Card className="p-4">
            <CardHeader className="p-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="w-4 h-4" />
                {tr("admin.progression.issue")}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="ph-lesson">{tr("admin.progression.lesson")}</Label>
                <select
                  id="ph-lesson"
                  value={lessonId}
                  onChange={(e) => setLessonId(e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">—</option>
                  {lessons.map((l) => (
                    <option key={l.id} value={l.id}>
                      {lessonLabel(l.id)}
                      {l.state && STATE_LABEL_KEYS[l.state]
                        ? ` — ${tr(STATE_LABEL_KEYS[l.state])}`
                        : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ph-reason">{tr("admin.progression.reason")} *</Label>
                <Textarea
                  id="ph-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={tr("admin.progression.reason")}
                  rows={3}
                  className="resize-none"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ph-expiry">
                  {tr("admin.progression.expiry")} · {tr("admin.progression.neverExpires")}
                </Label>
                <Input
                  id="ph-expiry"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>

              <div className="flex justify-end">
                <Button onClick={issue} disabled={busy || !lessonId}>
                  {busy ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4" />
                  )}
                  <span className="ms-2">{tr("admin.progression.issue")}</span>
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ------------------------------------------------------------ */}
          {/* 4. History (revocation never deletes a row)                   */}
          {/* ------------------------------------------------------------ */}
          <Card className="p-4">
            <CardHeader className="p-0 pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock3 className="w-4 h-4" />
                {tr("admin.progression.history")}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {consoleData.overrides.length === 0 ? (
                <p className="text-center text-xs text-muted-foreground py-3">
                  {tr("admin.progression.empty")}
                </p>
              ) : (
                <div className="space-y-2">
                  {consoleData.overrides.map((o) => {
                    const actor = consoleData.actors?.[o.createdByUserId] ?? o.createdByUserId;
                    return (
                      <div
                        key={o.id}
                        className="rounded-lg border border-border p-3 flex flex-wrap items-start justify-between gap-2"
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${
                                o.valid
                                  ? "border-emerald-500/40 text-emerald-600"
                                  : "border-border text-muted-foreground"
                              }`}
                            >
                              {o.revokedAt
                                ? tr("admin.progression.revokedState")
                                : o.valid
                                  ? tr("admin.progression.active")
                                  : tr("admin.progression.expired")}
                            </Badge>
                            <span className="text-sm font-medium">{lessonLabel(o.lessonId)}</span>
                          </div>
                          <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                            {o.reason}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {tr("admin.progression.by")} {actor} · {tr("admin.progression.issuedAt")}{" "}
                            <span dir="ltr">{fmtDateTime(o.createdAt, tr)}</span>
                            {" · "}
                            {o.expiresAt ? (
                              <span dir="ltr">{fmtDateTime(o.expiresAt, tr)}</span>
                            ) : (
                              tr("admin.progression.neverExpires")
                            )}
                          </p>
                          {o.revokedAt && (
                            <p className="text-[11px] text-muted-foreground">
                              {tr("admin.progression.revoked")} ·{" "}
                              <span dir="ltr">{fmtDateTime(o.revokedAt, tr)}</span>
                              {o.revokeReason ? ` · ${o.revokeReason}` : ""}
                            </p>
                          )}
                        </div>
                        {o.valid && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={revokingId === o.id}
                            onClick={() => revoke(o.id)}
                          >
                            {revokingId === o.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Ban className="w-4 h-4" />
                            )}
                            <span className="ms-2">{tr("admin.progression.revoke")}</span>
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Lesson options carry their canonical state — kept for a11y/tests. */}
      <span className="hidden" data-testid="admin-progression-lesson-count">
        {lessons.length}
      </span>
    </motion.div>
  );
}

export default ProgressionOverridesView;
