"use client";

// ============================================================
// CodeMind Academy — Admin: session publishing workflow (list)
//
// The list half of the Phase 15 workflow. Each row shows the four facts
// that must always agree — scope, resources, readiness, status — straight
// from `GET /api/admin/lessons?includeReadiness=1`. Readiness is rendered
// from the server snapshot; the component evaluates nothing itself.
//
// Selecting a row opens the session detail (same view, `navParam` carries
// the lesson id — the `student-lesson` navigation convention).
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useApp } from "@/lib/store";
import { useT, pickAuto } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus,
  Search,
  ChevronLeft,
  ChevronRight,
  Archive,
  ArchiveRestore,
  Loader2,
  BookOpen,
  FileQuestion,
  ClipboardList,
  FileText,
  Video,
} from "lucide-react";
import {
  ConfirmDialog,
  CurriculumBadge,
  StatusBadge,
  TrackScopeBadge,
  fetchJson,
  serverErrorText,
  type AdminSessionListItem,
  type AdminSessionListResponse,
} from "@/components/admin/session-workflow-shared";
import { SessionDetailView } from "@/components/admin/session-detail-view";

type Filters = {
  q: string;
  status: string;
  trackScope: string;
  curriculumStatus: string;
};

const EMPTY_FILTERS: Filters = { q: "", status: "", trackScope: "", curriculumStatus: "" };

export function SessionWorkflowView() {
  const navParam = useApp((s) => s.navParam);
  const setNavParam = useApp((s) => s.setNavParam);
  if (navParam) {
    return <SessionDetailView lessonId={navParam} onBack={() => setNavParam(null)} />;
  }
  return <SessionListView />;
}

function SessionListView() {
  const tr = useT();
  const setNavParam = useApp((s) => s.setNavParam);
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  const [debouncedQ, setDebouncedQ] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<AdminSessionListResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [openCreate, setOpenCreate] = React.useState(false);
  const [archiveTarget, setArchiveTarget] = React.useState<AdminSessionListItem | null>(null);
  const [archiving, setArchiving] = React.useState(false);

  // Debounce the search box so typing does not fan out requests.
  React.useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(filters.q.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [filters.q]);

  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (filters.status) params.set("status", filters.status);
    if (filters.trackScope) params.set("trackScope", filters.trackScope);
    if (filters.curriculumStatus) params.set("curriculumStatus", filters.curriculumStatus);
    params.set("includeReadiness", "1");
    params.set("page", String(page));
    return `/api/admin/lessons?${params.toString()}`;
  }, [debouncedQ, filters.status, filters.trackScope, filters.curriculumStatus, page]);

  // Fetch on mount and whenever the query changes. State updates happen
  // only in the promise continuation — never synchronously in the effect —
  // and the `alive` flag drops late responses after unmount/remount.
  React.useEffect(() => {
    let alive = true;
    fetchJson<AdminSessionListResponse>(query).then((res) => {
      if (!alive) return;
      if (!res.ok) {
        setLoadError(serverErrorText(tr, res.error));
        setData(null);
      } else {
        setData(res.data);
        setLoadError(null);
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [query, tr]);

  // Explicit refresher for retry / created / archive (event contexts, where
  // raising the loading flag synchronously is correct).
  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await fetchJson<AdminSessionListResponse>(query);
    if (!res.ok) {
      setLoadError(serverErrorText(tr, res.error));
      setData(null);
    } else {
      setData(res.data);
      setLoadError(null);
    }
    setLoading(false);
  }, [query, tr]);

  const runArchive = async (restore: boolean) => {
    if (!archiveTarget) return;
    setArchiving(true);
    const res = await fetchJson<{ code: string; changed: boolean }>(
      `/api/admin/lessons/${encodeURIComponent(archiveTarget.id)}/archive`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: restore ? "RESTORE" : "ARCHIVE" }),
      }
    );
    setArchiving(false);
    if (!res.ok) {
      // The server refuses to archive a published session: surface the
      // specific guidance instead of the raw code.
      if (res.status === 409 && /ARCHIVE_REQUIRES_UNPUBLISH/.test(res.error)) {
        toast.error(tr("admin.340"));
      } else {
        toast.error(serverErrorText(tr, res.error));
      }
      return;
    }
    toast.success(tr(restore ? "admin.338" : "admin.337"));
    setArchiveTarget(null);
    load();
  };

  const archivedTarget = archiveTarget?.curriculumStatus === "ARCHIVED";

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{tr("admin.323")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.324")}</p>
        </div>
        <Button onClick={() => setOpenCreate(true)}>
          <Plus className="w-4 h-4 me-2" />
          {tr("admin.330")}
        </Button>
      </div>

      <Card className="p-4">
        <div className="grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
          <div className="relative">
            <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              value={filters.q}
              onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
              placeholder={tr("admin.325")}
              className="ps-9"
              aria-label={tr("admin.325")}
            />
          </div>
          <FilterSelect
            label={tr("admin.326")}
            value={filters.status}
            onChange={(v) => {
              setFilters((f) => ({ ...f, status: v }));
              setPage(1);
            }}
            options={[
              { value: "DRAFT", label: tr("admin.343") },
              { value: "READY", label: tr("admin.344") },
              { value: "PUBLISHED", label: tr("admin.345") },
            ]}
            allLabel={tr("admin.329")}
          />
          <FilterSelect
            label={tr("admin.327")}
            value={filters.trackScope}
            onChange={(v) => {
              setFilters((f) => ({ ...f, trackScope: v }));
              setPage(1);
            }}
            options={[
              { value: "SHARED", label: tr("admin.349") },
              { value: "ARABIC", label: tr("admin.350") },
              { value: "LANGUAGE", label: tr("admin.351") },
            ]}
            allLabel={tr("admin.329")}
          />
          <FilterSelect
            label={tr("admin.328")}
            value={filters.curriculumStatus}
            onChange={(v) => {
              setLoading(true);
              setFilters((f) => ({ ...f, curriculumStatus: v }));
              setPage(1);
            }}
            options={[
              { value: "OFFICIAL", label: tr("admin.346") },
              { value: "LEGACY", label: tr("admin.347") },
              { value: "ARCHIVED", label: tr("admin.321") },
            ]}
            allLabel={tr("admin.329")}
          />
        </div>

        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {data ? tr("admin.481", { p1: data.pagination.total }) : "—"}
          </span>
          {data && data.pagination.totalPages > 1 && (
            <span>{tr("admin.482", { p1: data.pagination.page, p2: data.pagination.totalPages })}</span>
          )}
        </div>

        <div className="mt-3 space-y-2">
          {loading ? (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)
          ) : loadError ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-muted-foreground">{tr("admin.450")}: {loadError}</p>
              <Button size="sm" variant="outline" onClick={load}>
                {tr("admin.002")}
              </Button>
            </div>
          ) : !data || data.lessons.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{tr("admin.331")}</p>
          ) : (
            data.lessons.map((lesson) => (
              <SessionRow
                key={lesson.id}
                lesson={lesson}
                onOpen={() => setNavParam(lesson.id)}
                onArchive={() => setArchiveTarget(lesson)}
              />
            ))
          )}
        </div>

        {data && data.pagination.totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronRight className="w-4 h-4 me-1 flip-rtl" />
              {tr("admin.232")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!data.pagination.hasMore || loading}
              onClick={() => setPage((p) => p + 1)}
            >
              {tr("admin.233")}
              <ChevronLeft className="w-4 h-4 ms-1 flip-rtl" />
            </Button>
          </div>
        )}
      </Card>

      <CreateSessionDialog open={openCreate} onOpenChange={setOpenCreate} onCreated={load} />

      <ConfirmDialog
        open={!!archiveTarget}
        onOpenChange={(v) => !v && setArchiveTarget(null)}
        title={tr(archivedTarget ? "admin.334" : "admin.333")}
        description={archivedTarget ? tr("admin.338") : tr("admin.339")}
        confirmLabel={tr(archivedTarget ? "admin.334" : "admin.333")}
        confirmingLabel={tr(archivedTarget ? "admin.336" : "admin.335")}
        confirming={archiving}
        danger={!archivedTarget}
        onConfirm={() => runArchive(archivedTarget)}
      />
    </motion.div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground whitespace-nowrap">{label}</span>
      <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
        <SelectTrigger className="w-[130px]" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SessionRow({
  lesson,
  onOpen,
  onArchive,
}: {
  lesson: AdminSessionListItem;
  onOpen: () => void;
  onArchive: () => void;
}) {
  const tr = useT();
  const archived = lesson.curriculumStatus === "ARCHIVED";
  const readiness = lesson.readiness;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40 ${
        archived ? "opacity-75" : ""
      }`}
    >
      <div className="grid place-items-center w-9 h-9 shrink-0 rounded-lg bg-primary/10 text-primary">
        <BookOpen className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-1.5">
          {lesson.officialCode && (
            <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">
              {lesson.officialCode}
            </Badge>
          )}
          <span className="truncate text-sm font-semibold">
            {pickAuto(lesson.titleAr, lesson.title)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <StatusBadge status={lesson.status} />
          <TrackScopeBadge scope={lesson.trackScope} />
          <CurriculumBadge value={lesson.curriculumStatus} />
          {readiness && (
            <Badge
              variant="outline"
              className={`text-[10px] ${
                readiness.canBeReady
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                  : "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"
              }`}
              title={readiness.blocking.join(", ")}
            >
              {readiness.canBeReady ? tr("admin.413") : tr("admin.414")}
            </Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Video className="w-3 h-3" />
            <span dir="ltr">
              {lesson.counts.sessionVideosPublished}/{lesson.counts.sessionVideos}
            </span>
          </span>
          <span className="inline-flex items-center gap-1">
            <FileText className="w-3 h-3" />
            <span dir="ltr">{lesson.counts.materials}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <FileQuestion className="w-3 h-3" />
            <span dir="ltr">{lesson.counts.quizzes}</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <ClipboardList className="w-3 h-3" />
            <span dir="ltr">{lesson.counts.homeworks}</span>
          </span>
          {lesson.legacy.hasVideoUrl && (
            <Badge variant="secondary" className="text-[10px]">
              {tr("admin.419")}
            </Badge>
          )}
          {lesson.legacy.hasPdfUrl && (
            <Badge variant="secondary" className="text-[10px]">
              {tr("admin.477")}
            </Badge>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 ms-auto">
        <Button
          size="sm"
          variant="ghost"
          aria-label={tr(archived ? "admin.334" : "admin.333")}
          title={tr(archived ? "admin.334" : "admin.333")}
          onClick={onArchive}
        >
          {archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
        </Button>
        <Button size="sm" onClick={onOpen}>
          {tr("admin.332")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create dialog — DRAFT-only, canonical chain, no official codes
// ---------------------------------------------------------------------------

type UnitOption = {
  id: string;
  label: string;
};

function CreateSessionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const tr = useT();
  const [units, setUnits] = React.useState<UnitOption[]>([]);
  const [unitsLoading, setUnitsLoading] = React.useState(true);
  const [form, setForm] = React.useState({
    title: "",
    titleAr: "",
    unitId: "",
    trackScope: "SHARED",
    description: "",
    summary: "",
    duration: "",
  });
  const [saving, setSaving] = React.useState(false);

  // Units load when the dialog opens; states update only in the promise
  // continuation. The loading flag is re-armed by `handleOpenChange` on
  // close (an event context), so every opening starts in a loading state.
  React.useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch("/api/admin/courses?tree=1")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const all: UnitOption[] = [];
        for (const c of d.courses || []) {
          for (const p of c.parts || []) {
            for (const u of p.units || []) {
              all.push({
                id: u.id,
                label: `${pickAuto(c.nameAr, c.name)} · ${pickAuto(p.titleAr, p.title)} · ${pickAuto(u.titleAr, u.title)}`,
              });
            }
          }
        }
        setUnits(all);
      })
      .catch(() => {
        if (alive) setUnits([]);
      })
      .finally(() => {
        if (alive) setUnitsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setUnits([]);
      setUnitsLoading(true);
    }
    onOpenChange(v);
  };

  const submit = async () => {
    if (!form.title.trim() || !form.titleAr.trim()) {
      toast.error(tr("admin.488"));
      return;
    }
    if (!form.unitId) {
      toast.error(tr("admin.487"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetchJson<{ lesson: { id: string } }>("/api/admin/lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(),
          titleAr: form.titleAr.trim(),
          unitId: form.unitId,
          trackScope: form.trackScope,
          description: form.description.trim() || undefined,
          summary: form.summary.trim() || undefined,
          duration: form.duration ? Number(form.duration) : undefined,
        }),
      });
      if (!res.ok) {
        toast.error(serverErrorText(tr, res.error));
        return;
      }
      toast.success(tr("admin.365"));
      handleOpenChange(false);
      setForm({
        title: "",
        titleAr: "",
        unitId: "",
        trackScope: "SHARED",
        description: "",
        summary: "",
        duration: "",
      });
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("admin.354")}</DialogTitle>
          <DialogDescription>{tr("admin.355")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="sw-title">{tr("admin.356")}</Label>
            <Input
              id="sw-title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              dir="ltr"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sw-titleAr">{tr("admin.357")}</Label>
            <Input
              id="sw-titleAr"
              value={form.titleAr}
              onChange={(e) => setForm({ ...form, titleAr: e.target.value })}
              dir="rtl"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{tr("admin.358")}</Label>
            <Select value={form.unitId} onValueChange={(v) => setForm({ ...form, unitId: v })}>
              <SelectTrigger aria-label={tr("admin.358")}>
                <SelectValue placeholder={unitsLoading ? "…" : tr("admin.359")} />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                {units.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>{tr("admin.489")}</Label>
            <Select value={form.trackScope} onValueChange={(v) => setForm({ ...form, trackScope: v })}>
              <SelectTrigger aria-label={tr("admin.489")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SHARED">{tr("admin.349")}</SelectItem>
                <SelectItem value="ARABIC">{tr("admin.350")}</SelectItem>
                <SelectItem value="LANGUAGE">{tr("admin.351")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sw-desc">{tr("admin.360")}</Label>
            <Textarea
              id="sw-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sw-summary">{tr("admin.361")}</Label>
            <Textarea
              id="sw-summary"
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
              rows={2}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sw-duration">{tr("admin.362")}</Label>
            <Input
              id="sw-duration"
              type="number"
              min={1}
              max={1440}
              value={form.duration}
              onChange={(e) => setForm({ ...form, duration: e.target.value })}
              dir="ltr"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {tr("admin.288")}
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {saving ? tr("admin.363") : tr("admin.364")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
