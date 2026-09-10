"use client";

// ============================================================
// CodeMind Academy — Admin: session detail workflow
//
// ONE screen for the whole publishing workflow of a session:
//
//   Curriculum identity → Status → Track scope → Video → PDF →
//   Quiz → Homework → Readiness → Open action → Publication history
//
// Data comes from a SINGLE `GET /api/admin/lessons/[id]` call; every
// mutation (edit, archive, PDF change, lifecycle ceremony) refreshes that
// same payload, so the screen can never mix fresh state with stale
// readiness. No optimistic publish: buttons stay disabled until the
// server confirms, and retries are idempotent by construction.
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useApp } from "@/lib/store";
import { useT, pickAuto } from "@/lib/i18n";
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
  ArrowRight,
  Pencil,
  Archive,
  ArchiveRestore,
  Loader2,
  Video as VideoIcon,
  FileQuestion,
  ClipboardList,
  History,
  Rocket,
  CheckCircle2,
} from "lucide-react";
import {
  ConfirmDialog,
  CurriculumBadge,
  ReadinessChecklist,
  SectionCard,
  StatusBadge,
  TrackScopeBadge,
  WorkflowStepper,
  fetchJson,
  formatDateTime,
  serverErrorText,
  type AdminSessionDetail,
  type AdminSessionQuizSummary,
  type AdminSessionHomeworkSummary,
  type AdminSessionVideoSummary,
} from "@/components/admin/session-workflow-shared";
import {
  MarkReadyDialog,
  OpenSessionDialog,
  UnpublishDialog,
} from "@/components/admin/session-open-dialog";
import { SessionPdfManager } from "@/components/admin/session-pdf-manager";

export function SessionDetailView({
  lessonId,
  onBack,
}: {
  lessonId: string;
  onBack: () => void;
}) {
  const tr = useT();
  const [detail, setDetail] = React.useState<AdminSessionDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [openEdit, setOpenEdit] = React.useState(false);
  const [openMarkReady, setOpenMarkReady] = React.useState(false);
  const [openOpen, setOpenOpen] = React.useState(false);
  const [openUnpublish, setOpenUnpublish] = React.useState(false);
  const [archiveOpen, setArchiveOpen] = React.useState(false);
  const [archiving, setArchiving] = React.useState(false);

  // Single fetch for the whole screen, on mount and whenever the lesson
  // changes. State updates happen only in the promise continuation — never
  // synchronously in the effect — and the `alive` flag drops late
  // responses after unmount/remount.
  React.useEffect(() => {
    let alive = true;
    fetchJson<AdminSessionDetail>(
      `/api/admin/lessons/${encodeURIComponent(lessonId)}`
    ).then((res) => {
      if (!alive) return;
      if (!res.ok) {
        setLoadError(serverErrorText(tr, res.error));
        setDetail(null);
      } else {
        setDetail(res.data);
        setLoadError(null);
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [lessonId, tr]);

  // Explicit refresher every mutation calls after the server confirms, so
  // the screen can never mix fresh state with stale readiness.
  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await fetchJson<AdminSessionDetail>(
      `/api/admin/lessons/${encodeURIComponent(lessonId)}`
    );
    if (!res.ok) {
      setLoadError(serverErrorText(tr, res.error));
      setDetail(null);
    } else {
      setDetail(res.data);
      setLoadError(null);
    }
    setLoading(false);
  }, [lessonId, tr]);

  const runArchive = async (restore: boolean) => {
    setArchiving(true);
    try {
      const res = await fetchJson<{ code: string }>(
        `/api/admin/lessons/${encodeURIComponent(lessonId)}/archive`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: restore ? "RESTORE" : "ARCHIVE" }),
        }
      );
      if (!res.ok) {
        if (res.status === 409 && /ARCHIVE_REQUIRES_UNPUBLISH/.test(res.error)) {
          toast.error(tr("admin.340"));
        } else {
          toast.error(serverErrorText(tr, res.error));
        }
        return;
      }
      toast.success(tr(restore ? "admin.338" : "admin.337"));
      setArchiveOpen(false);
      load();
    } finally {
      setArchiving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (loadError || !detail) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          {tr("admin.451")}{loadError ? `: ${loadError}` : ""}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onBack}>
            {tr("admin.367")}
          </Button>
          <Button size="sm" variant="outline" onClick={load}>
            {tr("admin.002")}
          </Button>
        </div>
      </div>
    );
  }

  const archived = detail.curriculumStatus === "ARCHIVED";
  const isDraft = detail.status === "DRAFT";
  const isReady = detail.status === "READY";
  const isPublished = detail.status === "PUBLISHED";

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Button size="sm" variant="ghost" onClick={onBack} className="mb-1 -ms-2">
            <ArrowRight className="w-4 h-4 me-1 flip-rtl" />
            {tr("admin.367")}
          </Button>
          <h2 className="text-xl font-bold break-words">
            {detail.officialCode && (
              <span className="font-mono text-base text-muted-foreground me-2" dir="ltr">
                {detail.officialCode}
              </span>
            )}
            {pickAuto(detail.titleAr, detail.title)}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={detail.status} />
            <TrackScopeBadge scope={detail.trackScope} />
            <CurriculumBadge value={detail.curriculumStatus} />
            {detail.publication && (
              <Badge variant="outline" className="text-[10px]">
                {tr("admin.439")}: {formatDateTime(detail.publication.publishedAt)}
              </Badge>
            )}
          </div>
          <div className="mt-2.5">
            <WorkflowStepper status={detail.status} canBeReady={detail.readiness.canBeReady} />
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpenEdit(true)} disabled={archived}>
            <Pencil className="w-3.5 h-3.5 me-1.5" />
            {tr("admin.374")}
          </Button>
          {isDraft && !archived && (
            <Button size="sm" variant="outline" onClick={() => setOpenMarkReady(true)}>
              <CheckCircle2 className="w-3.5 h-3.5 me-1.5" />
              {tr("admin.386")}
            </Button>
          )}
          {isReady && !archived && (
            <Button size="sm" onClick={() => setOpenOpen(true)}>
              <Rocket className="w-3.5 h-3.5 me-1.5" />
              {tr("admin.389")}
            </Button>
          )}
          {isPublished && !archived && (
            <Button size="sm" variant="outline" onClick={() => setOpenUnpublish(true)}>
              {tr("admin.243")}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setArchiveOpen(true)}
            title={tr(archived ? "admin.334" : "admin.333")}
          >
            {archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      {archived && (
        <p className="rounded-lg border bg-muted/50 p-2.5 text-xs text-muted-foreground">
          {tr("admin.452")}
        </p>
      )}
      {isDraft && !archived && (
        <p className="rounded-lg border bg-muted/50 p-2.5 text-xs text-muted-foreground">
          {tr("admin.453")}
        </p>
      )}

      {/* Curriculum identity */}
      <SectionCard title={tr("admin.368")}>
        <IdentityGrid detail={detail} />
        {detail.description && (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{detail.description}</p>
        )}
        {detail.summary && (
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{detail.summary}</p>
        )}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>
            {tr("admin.446")}: <span dir="ltr">{detail.order}</span>
          </span>
          <span>
            {tr("admin.447")}: <span dir="ltr">{detail.duration}</span> {tr("teacher.147")}
          </span>
        </div>
      </SectionCard>

      {/* Readiness */}
      <SectionCard
        title={tr("admin.384")}
        action={
          <Badge
            variant="outline"
            className={
              detail.readiness.canBeReady
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                : "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30"
            }
          >
            {detail.readiness.canBeReady ? tr("admin.413") : tr("admin.414")}
          </Badge>
        }
      >
        <ReadinessChecklist readiness={detail.readiness} />
      </SectionCard>

      {/* Video — display only; staging lives in the session-videos view */}
      <SectionCard
        title={tr("admin.380")}
        action={<ManageVideosButton />}
      >
        <VideoSection detail={detail} />
      </SectionCard>

      {/* PDF */}
      <SectionCard title={tr("admin.381")}>
        <SessionPdfManager
          lessonId={detail.id}
          lessonTrackScope={detail.trackScope}
          materials={detail.materials}
          onChanged={load}
        />
        {detail.legacy.pdfUrl && (
          <p className="text-[11px] text-muted-foreground">
            {tr("admin.477")}:{" "}
            <a
              href={detail.legacy.pdfUrl}
              target="_blank"
              rel="noreferrer"
              className="underline break-all"
              dir="ltr"
            >
              {detail.legacy.pdfUrl}
            </a>
          </p>
        )}
      </SectionCard>

      {/* Quiz */}
      <SectionCard title={tr("admin.382")} action={<ManageQuestionsButton lessonId={lessonId} />}>
        <QuizSection quizzes={detail.quizzes} />
      </SectionCard>

      {/* Homework — read-only in Phase 15; creation is a Phase 18 dependency */}
      <SectionCard title={tr("admin.383")}>
        <HomeworkSection homeworks={detail.homeworks} />
        <p className="rounded-lg bg-muted/50 p-2.5 text-[11px] text-muted-foreground">
          {tr("admin.435")}
        </p>
      </SectionCard>

      {/* Publication history */}
      <SectionCard title={tr("admin.385")}>
        <HistorySection detail={detail} />
      </SectionCard>

      <EditSessionDialog
        open={openEdit}
        onOpenChange={setOpenEdit}
        detail={detail}
        onSaved={load}
      />
      <MarkReadyDialog
        open={openMarkReady}
        onOpenChange={setOpenMarkReady}
        detail={detail}
        onDone={load}
      />
      <OpenSessionDialog open={openOpen} onOpenChange={setOpenOpen} detail={detail} onDone={load} />
      <UnpublishDialog
        open={openUnpublish}
        onOpenChange={setOpenUnpublish}
        detail={detail}
        onDone={load}
      />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={tr(archived ? "admin.334" : "admin.333")}
        description={archived ? tr("admin.338") : tr("admin.339")}
        confirmLabel={tr(archived ? "admin.334" : "admin.333")}
        confirmingLabel={tr(archived ? "admin.336" : "admin.335")}
        confirming={archiving}
        danger={!archived}
        onConfirm={() => runArchive(archived)}
      />
    </motion.div>
  );
}

// ---------------------------------------------------------------------------

function IdentityGrid({ detail }: { detail: AdminSessionDetail }) {
  const tr = useT();
  const { identity } = detail;
  if (!identity.course && !identity.part && !identity.unit) {
    return <p className="text-sm text-muted-foreground">{tr("admin.373")}</p>;
  }
  const cells: { label: string; value: string }[] = [];
  if (identity.course)
    cells.push({ label: tr("admin.369"), value: pickAuto(identity.course.nameAr, identity.course.name) });
  if (identity.part)
    cells.push({ label: tr("admin.370"), value: pickAuto(identity.part.titleAr, identity.part.title) });
  if (identity.unit)
    cells.push({ label: tr("admin.358"), value: pickAuto(identity.unit.titleAr, identity.unit.title) });
  if (identity.topic)
    cells.push({ label: tr("admin.372"), value: pickAuto(identity.topic.titleAr, identity.topic.title) });
  return (
    <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {cells.map((c) => (
        <div key={c.label} className="rounded-lg border p-2.5">
          <dt className="text-[11px] text-muted-foreground">{c.label}</dt>
          <dd className="mt-0.5 text-sm font-semibold break-words">{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ManageVideosButton() {
  const tr = useT();
  const setView = useApp((s) => s.setView);
  return (
    <Button size="sm" variant="outline" onClick={() => setView("admin-session-videos")}>
      <VideoIcon className="w-3.5 h-3.5 me-1.5" />
      {tr("admin.418")}
    </Button>
  );
}

function ManageQuestionsButton({ lessonId }: { lessonId: string }) {
  const tr = useT();
  const setView = useApp((s) => s.setView);
  const setNavParam = useApp((s) => s.setNavParam);
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        // setView clears navParam, so the param is set AFTER the view —
        // the question bank preselects this lesson for AI generation.
        setView("admin-question-bank");
        setNavParam(lessonId);
      }}
    >
      <FileQuestion className="w-3.5 h-3.5 me-1.5" />
      {tr("admin.433")}
    </Button>
  );
}

function VideoSection({ detail }: { detail: AdminSessionDetail }) {
  const tr = useT();
  const videos = detail.sessionVideos;
  return (
    <div className="space-y-2">
      {detail.trackScope === "SHARED" && (
        <p className="text-[11px] text-muted-foreground">{tr("admin.473")}</p>
      )}
      {videos.length === 0 && !detail.legacy.videoUrl && (
        <p className="py-2 text-center text-sm text-muted-foreground">{tr("admin.417")}</p>
      )}
      {detail.legacy.videoUrl && (
        <p className="text-[11px] text-muted-foreground">
          {tr("admin.419")}:{" "}
          <a
            href={detail.legacy.videoUrl}
            target="_blank"
            rel="noreferrer"
            className="underline break-all"
            dir="ltr"
          >
            {detail.legacy.videoUrl}
          </a>
        </p>
      )}
      {videos.map((v) => (
        <VideoRow key={v.id} video={v} />
      ))}
      {videos.some((v) => !v.isPublished) && (
        <p className="text-[11px] text-muted-foreground">{tr("admin.485")}</p>
      )}
    </div>
  );
}

function VideoRow({ video: v }: { video: AdminSessionVideoSummary }) {
  const tr = useT();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-2.5">
      <div className="grid place-items-center w-8 h-8 shrink-0 rounded-lg bg-primary/10 text-primary">
        <VideoIcon className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <div className="truncate text-sm font-semibold">{pickAuto(v.titleAr, v.title)}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <TrackScopeBadge scope={v.batch.schoolType} />
          <Badge
            variant="outline"
            className={`text-[10px] ${
              v.isPublished
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
            }`}
          >
            {v.isPublished ? tr("admin.472") : tr("admin.471")}
          </Badge>
          <span className="text-[10px] text-muted-foreground" dir="ltr">
            {v.requiredPercent}%
          </span>
        </div>
      </div>
      <span className="text-[10px] text-muted-foreground ms-auto">
        {formatDateTime(v.publishedAt || v.createdAt)}
      </span>
    </div>
  );
}

function QuizSection({ quizzes }: { quizzes: AdminSessionQuizSummary[] }) {
  const tr = useT();
  if (quizzes.length === 0) {
    return <p className="py-2 text-center text-sm text-muted-foreground">{tr("admin.432")}</p>;
  }
  return (
    <div className="space-y-2">
      {quizzes.map((qz) => (
        <div key={qz.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-2.5">
          <div className="grid place-items-center w-8 h-8 shrink-0 rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-300">
            <FileQuestion className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1 basis-40">
            <div className="truncate text-sm font-semibold">{pickAuto(qz.titleAr, qz.title)}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <TrackScopeBadge scope={qz.trackScope} />
              {qz.questionCount === 0 ? (
                <Badge variant="outline" className="text-[10px] bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30">
                  {tr("admin.475")}
                </Badge>
              ) : (
                <span className="text-[11px] text-muted-foreground" dir="ltr">
                  {qz.questionCount} {tr("admin.474")}
                </span>
              )}
              <span className="text-[11px] text-muted-foreground">
                {tr("admin.469")}: <span dir="ltr">{qz.passMark}%</span>
              </span>
              {typeof qz.timeLimit === "number" && (
                <span className="text-[11px] text-muted-foreground">
                  {tr("admin.470")}: <span dir="ltr">{qz.timeLimit}</span>
                </span>
              )}
            </div>
            {qz.questionCount === 0 && (
              <p className="mt-1 text-[11px] text-red-700 dark:text-red-300">{tr("admin.436")}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function HomeworkSection({ homeworks }: { homeworks: AdminSessionHomeworkSummary[] }) {
  const tr = useT();
  if (homeworks.length === 0) {
    return <p className="py-2 text-center text-sm text-muted-foreground">{tr("admin.434")}</p>;
  }
  return (
    <div className="space-y-2">
      {homeworks.map((h) => (
        <div key={h.id} className="flex flex-wrap items-center gap-3 rounded-lg border p-2.5">
          <div className="grid place-items-center w-8 h-8 shrink-0 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300">
            <ClipboardList className="w-4 h-4" />
          </div>
          <div className="min-w-0 flex-1 basis-40">
            <div className="truncate text-sm font-semibold">{pickAuto(h.titleAr, h.title)}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <TrackScopeBadge scope={h.trackScope} />
              {!h.hasInstructions && (
                <Badge variant="outline" className="text-[10px] bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30">
                  {tr("admin.476")}
                </Badge>
              )}
              <span className="text-[11px] text-muted-foreground">
                {tr("admin.467")}: {formatDateTime(h.deadline)}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {tr("admin.468")}: <span dir="ltr">{h.maxMarks}</span>
              </span>
              <span className="text-[11px] text-muted-foreground">
                <span dir="ltr">{h.submissionsCount}</span> {tr("admin.466")}
              </span>
            </div>
            {!h.hasInstructions && (
              <p className="mt-1 text-[11px] text-red-700 dark:text-red-300">{tr("admin.437")}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function HistorySection({ detail }: { detail: AdminSessionDetail }) {
  const tr = useT();
  if (detail.history.length === 0) {
    return (
      <p className="py-2 text-center text-sm text-muted-foreground">{tr("admin.438")}</p>
    );
  }
  return (
    <ol className="space-y-1.5">
      {detail.history.map((h) => (
        <li key={h.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2 text-xs">
          <History className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]" dir="ltr">
            {h.action}
          </code>
          <span className="text-muted-foreground">
            {h.user ? `${tr("admin.440")} ${h.user.name} (${h.user.email})` : "—"}
          </span>
          <span className="text-muted-foreground ms-auto">{formatDateTime(h.createdAt)}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog — safe metadata + track scope only
// ---------------------------------------------------------------------------

function initialEditForm(detail: AdminSessionDetail) {
  return {
    title: detail.title,
    titleAr: detail.titleAr,
    description: detail.description || "",
    summary: detail.summary || "",
    duration: String(detail.duration),
    order: String(detail.order),
    trackScope: detail.trackScope,
  };
}

function EditSessionDialog({
  open,
  onOpenChange,
  detail,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  detail: AdminSessionDetail;
  onSaved: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState(() => initialEditForm(detail));
  const [saving, setSaving] = React.useState(false);

  // Reset the form on the closed→open transition (render-time adjustment —
  // the sanctioned alternative to syncing state inside an effect).
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setForm(initialEditForm(detail));
  }

  const submit = async () => {
    if (!form.title.trim() || !form.titleAr.trim()) {
      toast.error(tr("admin.488"));
      return;
    }
    setSaving(true);
    try {
      // Only the seven safe keys — the server rejects anything else.
      const res = await fetchJson<{ lesson: unknown }>(
        `/api/admin/lessons/${encodeURIComponent(detail.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: form.title.trim(),
            titleAr: form.titleAr.trim(),
            description: form.description.trim() || null,
            summary: form.summary.trim() || null,
            duration: Number(form.duration) || undefined,
            order: form.order === "" ? undefined : Number(form.order),
            trackScope: form.trackScope,
          }),
        }
      );
      if (!res.ok) {
        toast.error(serverErrorText(tr, res.error));
        return;
      }
      toast.success(tr("admin.379"));
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("admin.375")}</DialogTitle>
          <DialogDescription>{tr("admin.376")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="se-title">{tr("admin.356")}</Label>
            <Input
              id="se-title"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              dir="ltr"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="se-titleAr">{tr("admin.357")}</Label>
            <Input
              id="se-titleAr"
              value={form.titleAr}
              onChange={(e) => setForm({ ...form, titleAr: e.target.value })}
              dir="rtl"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{tr("admin.489")}</Label>
            <Select
              value={form.trackScope}
              onValueChange={(v) =>
                setForm({ ...form, trackScope: v as AdminSessionDetail["trackScope"] })
              }
            >
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
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="se-duration">{tr("admin.362")}</Label>
              <Input
                id="se-duration"
                type="number"
                min={1}
                max={1440}
                value={form.duration}
                onChange={(e) => setForm({ ...form, duration: e.target.value })}
                dir="ltr"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="se-order">{tr("admin.446")}</Label>
              <Input
                id="se-order"
                type="number"
                min={0}
                value={form.order}
                onChange={(e) => setForm({ ...form, order: e.target.value })}
                dir="ltr"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="se-desc">{tr("admin.360")}</Label>
            <Textarea
              id="se-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="se-summary">{tr("admin.361")}</Label>
            <Textarea
              id="se-summary"
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {tr("admin.288")}
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {saving ? tr("admin.377") : tr("admin.378")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
