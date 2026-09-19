"use client";

// ============================================================
// CodeMind Academy — Teacher Session Workspace (Phase E)
// ============================================================
//
// The teacher's coherent workspace around the academic Session
// (Course → Part → Unit → Lesson). Two levels:
//
//   SessionListView     — every lesson in the teacher's Group.courseId scope,
//                         with lifecycle + the four content indicators and
//                         the readiness verdict straight from the server.
//   SessionWorkspaceView — ONE lesson: overview · video (READ-ONLY) ·
//                         materials · quiz · homework · readiness summary.
//
// HARD RULES THIS FILE KEEPS (do not relax):
//   * Everything actionable is a RE-RENDER of a SERVER payload. Readiness,
//     indicator states and the `own` material flag are computed server-side;
//     this component never implements its own readiness or ownership logic.
//   * No admin authority is ever offered: no Mark Ready, no Open/Publish, no
//     Unpublish/Archive, no Override, no Video mutation. Video is presented
//     as read-only text on purpose.
//   * The teacher endpoints only — this file NEVER fetches /api/admin/*
//     (the Phase 18 pin family extends over it).
//   * After every mutation the workspace + list queries are invalidated so
//     indicators/readiness refresh without a browser reload (no polling).
//   * Arabic-first RTL, existing design system, no raw ids on screen.

import * as React from "react";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
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

import { useT } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import {
  CurriculumBadge,
  StatusBadge,
  TrackScopeBadge,
  ReadinessChecklist,
  ConfirmDialog,
  SectionCard,
  formatBytes,
  ReadinessStateIcon,
  type LessonReadinessSnapshot,
} from "@/components/admin/session-workflow-shared";
import {
  HomeworkDialog,
  QuestionManagerDialog,
  TrackScopeSelect,
  type HomeworkRecord,
} from "@/components/teacher/teacher-authoring";
import { useMediaUpload } from "@/hooks/use-media-upload";
import { sha256HexOfFile } from "@/lib/direct-upload";
import { uploadFailureMessage } from "@/lib/upload-error-text";

import {
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  FileText,
  ListChecks,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  Video,
  XCircle,
} from "lucide-react";

// ============================================================
// Payload types (mirrors of the Phase E API contracts)
// ============================================================

type Indicator = { state: "OK" | "INVALID" | "MISSING" | string; code: string; count: number };

type SessionListItem = {
  id: string;
  title: string;
  titleRaw: string;
  titleAr: string | null;
  order: number;
  officialCode: string | null;
  trackScope: string;
  status: string;
  curriculumStatus: string;
  archived: boolean;
  chain: "CANONICAL" | "LEGACY";
  course: { id: string; name: string };
  part: { id: string; title: string; order: number };
  unit: { id: string; title: string; order: number };
  canBeReady: boolean;
  blocking: string[];
  indicators: { VIDEO: Indicator; PDF: Indicator; QUIZ: Indicator; HOMEWORK: Indicator };
};

type MaterialRow = {
  id: string;
  title: string;
  kind: string;
  trackScope: string;
  isActive: boolean;
  own: boolean;
  downloadUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  originalName: string | null;
  createdAt: string;
};

type QuizRow = {
  id: string;
  title: string;
  titleRaw: string;
  titleAr: string | null;
  description: string | null;
  passMark: number;
  timeLimit: number | null;
  trackScope: string;
  order: number;
  questionCount: number;
  attemptsCount: number;
  status?: string;
  publishedAt?: string | null;
};

type HomeworkRow = {
  id: string;
  lessonId: string;
  title: string;
  titleRaw: string;
  titleAr: string | null;
  instructions: string | null;
  deadline: string;
  maxMarks: number;
  trackScope: string;
  createdAt: string;
  submissionsCount: number;
  gradedCount: number;
  status?: string;
  publishedAt?: string | null;
};

type Workspace = {
  lesson: SessionListItem & { legacyPdfUrl: string | null };
  video: {
    indicator: Indicator;
    publishedCount: number;
    unpublishedCount: number;
    audience: Array<{ track: "ARABIC" | "LANGUAGE"; published: boolean; unpublished: boolean }>;
  };
  materials: MaterialRow[];
  activeMaterialDescriptors: Array<{ id: string; title: string; trackScope: string }>;
  quizzes: QuizRow[];
  homework: HomeworkRow[];
  readiness: LessonReadinessSnapshot;
};

// ============================================================
// Small helpers
// ============================================================

const curLocale = () => (useApp.getState().locale === "en" ? "en" : "ar");
const dtLocale = () => (curLocale() === "en" ? "en-GB" : "ar-EG");
const shortDate = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(dtLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
};

/** localize-with-fallback for labels that are plain, dict-keyed copy. */
function lifecycleLabel(status: string | undefined, homework = false): string {
  if (status === "DRAFT") return "مسودة";
  if (status === "CLOSED") return "مغلق";
  return homework ? "منشور" : "منشور";
}

function lifecycleTone(status: string | undefined): string {
  if (status === "DRAFT") return "border-amber-500/30 text-amber-700 dark:text-amber-300";
  if (status === "CLOSED") return "border-slate-500/30 text-slate-700 dark:text-slate-300";
  return "border-emerald-500/30 text-emerald-700 dark:text-emerald-300";
}

function indicatorTone(state: string): string {
  if (state === "OK") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (state === "INVALID") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-border bg-muted/40 text-muted-foreground";
}

/** A tiny content chip: icon + readiness state coloring (+ count when > 0). */
function IndicatorChip({
  icon,
  label,
  indicator,
}: {
  icon: React.ReactNode;
  label: string;
  indicator: Indicator;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] font-semibold ${indicatorTone(indicator.state)}`}
      title={indicator.code}
    >
      {icon}
      <span>{label}</span>
      {indicator.state === "OK" && indicator.count > 0 && (
        <span className="tabular-nums" dir="ltr">
          {indicator.count}
        </span>
      )}
      {indicator.state === "OK" && (
        <CheckCircle2 className="w-3 h-3" aria-hidden="true" />
      )}
      {indicator.state === "INVALID" && (
        <AlertTriangle className="w-3 h-3" aria-hidden="true" />
      )}
    </span>
  );
}

/** The four indicator labels — the SAME vocabulary the admin readiness uses. */
function useIndicatorLabels() {
  const tr = useT();
  return {
    VIDEO: tr("admin.380"),
    PDF: tr("admin.381"),
    QUIZ: tr("admin.382"),
    HOMEWORK: tr("admin.383"),
  } as const;
}

// ============================================================
// Root: list ⇄ workspace
// ============================================================

export function TeacherSessions() {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  return selectedId ? (
    <SessionWorkspaceView lessonId={selectedId} onBack={() => setSelectedId(null)} />
  ) : (
    <SessionListView onOpen={(id) => setSelectedId(id)} />
  );
}

// ============================================================
// 1. Session LIST
// ============================================================

function SessionListView({ onOpen }: { onOpen: (lessonId: string) => void }) {
  const tr = useT();
  const labels = useIndicatorLabels();
  const [query, setQuery] = React.useState("");
  const [courseFilter, setCourseFilter] = React.useState<string>("ALL");
  const [readinessFilter, setReadinessFilter] = React.useState<string>("ALL");

  const sessionsQuery = useQuery<{ sessions: SessionListItem[] }>({
    queryKey: ["teacher-sessions"],
    queryFn: async () => {
      const r = await fetch("/api/teacher/sessions");
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return (await r.json()) as { sessions: SessionListItem[] };
    },
  });

  const sessions = React.useMemo(
    () => sessionsQuery.data?.sessions ?? [],
    [sessionsQuery.data]
  );
  const courses = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) map.set(s.course.id, s.course.name);
    return Array.from(map.entries());
  }, [sessions]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (courseFilter !== "ALL" && s.course.id !== courseFilter) return false;
      if (readinessFilter === "READY" && !s.canBeReady) return false;
      if (readinessFilter === "NOT_READY" && s.canBeReady) return false;
      if (!q) return true;
      const hay = `${s.title} ${s.titleRaw} ${s.officialCode ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [sessions, query, courseFilter, readinessFilter]);

  // Group the filtered rows by course (deterministic: the API's own order).
  const byCourse = React.useMemo(() => {
    const map = new Map<string, { name: string; rows: SessionListItem[] }>();
    for (const s of filtered) {
      if (!map.has(s.course.id)) map.set(s.course.id, { name: s.course.name, rows: [] });
      map.get(s.course.id)!.rows.push(s);
    }
    return Array.from(map.values());
  }, [filtered]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-5"
    >
      <div className="space-y-1.5">
        <h2 className="text-xl font-bold">{tr("teacher.215")}</h2>
        <p className="text-sm text-muted-foreground">{tr("teacher.216")}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-64">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tr("teacher.217")}
            aria-label={tr("teacher.217")}
          />
        </div>
        <Select value={courseFilter} onValueChange={setCourseFilter}>
          <SelectTrigger className="w-52" aria-label={tr("teacher.218")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{tr("teacher.218")}</SelectItem>
            {courses.map(([id, name]) => (
              <SelectItem key={id} value={id}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={readinessFilter} onValueChange={setReadinessFilter}>
          <SelectTrigger className="w-40" aria-label={tr("teacher.224")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{tr("teacher.224")}</SelectItem>
            <SelectItem value="READY">{tr("teacher.222")}</SelectItem>
            <SelectItem value="NOT_READY">{tr("teacher.223")}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          onClick={() => sessionsQuery.refetch()}
          disabled={sessionsQuery.isFetching}
          aria-label={tr("teacher.220")}
        >
          <RefreshCw className={`w-4 h-4 ${sessionsQuery.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Body */}
      {sessionsQuery.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : sessionsQuery.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center space-y-3">
          <p className="text-sm font-medium text-destructive">{tr("teacher.221")}</p>
          <p className="text-xs text-muted-foreground">
            {(sessionsQuery.error as Error)?.message}
          </p>
          <Button variant="outline" onClick={() => sessionsQuery.refetch()}>
            <RefreshCw className="w-4 h-4 me-1.5" />
            {tr("teacher.220")}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border bg-card p-10 text-center space-y-2">
          <ListChecks className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{tr("teacher.219")}</p>
        </div>
      ) : (
        byCourse.map((group) => (
          <section key={group.name} className="space-y-2.5">
            <h3 className="text-sm font-bold text-primary">{group.name}</h3>
            <div className="space-y-2">
              {group.rows.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onOpen(s.id)}
                  className="w-full text-start rounded-xl border bg-card p-3.5 transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {s.officialCode && (
                      <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">
                        {s.officialCode}
                      </Badge>
                    )}
                    <span className="text-sm font-bold">{s.title}</span>
                    <TrackScopeBadge scope={s.trackScope} />
                    {s.archived ? (
                      <CurriculumBadge value="ARCHIVED" />
                    ) : (
                      <StatusBadge status={s.status} />
                    )}
                    <span
                      className={`ms-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                        s.canBeReady
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                      }`}
                    >
                      {s.canBeReady ? (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5" />
                      )}
                      {s.canBeReady ? tr("teacher.222") : tr("teacher.223")}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span>
                      {s.part.title} · {s.unit.title}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <IndicatorChip
                      icon={<Video className="w-3 h-3" />}
                      label={labels.VIDEO}
                      indicator={s.indicators.VIDEO}
                    />
                    <IndicatorChip
                      icon={<FileText className="w-3 h-3" />}
                      label={labels.PDF}
                      indicator={s.indicators.PDF}
                    />
                    <IndicatorChip
                      icon={<ListChecks className="w-3 h-3" />}
                      label={labels.QUIZ}
                      indicator={s.indicators.QUIZ}
                    />
                    <IndicatorChip
                      icon={<ClipboardList className="w-3 h-3" />}
                      label={labels.HOMEWORK}
                      indicator={s.indicators.HOMEWORK}
                    />
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </motion.div>
  );
}

// ============================================================
// 2. Session WORKSPACE
// ============================================================

function useWorkspace(lessonId: string) {
  return useQuery<Workspace>({
    queryKey: ["teacher-session", lessonId],
    queryFn: async () => {
      const r = await fetch(`/api/teacher/sessions/${encodeURIComponent(lessonId)}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return (await r.json()) as Workspace;
    },
  });
}

function SessionWorkspaceView({
  lessonId,
  onBack,
}: {
  lessonId: string;
  onBack: () => void;
}) {
  const tr = useT();
  const queryClient = useQueryClient();
  const ws = useWorkspace(lessonId);

  /** One place every mutation calls after success — workspace + list. */
  const refresh = React.useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["teacher-session", lessonId] });
    queryClient.invalidateQueries({ queryKey: ["teacher-sessions"] });
  }, [queryClient, lessonId]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <Button variant="outline" size="sm" onClick={onBack}>
        <ArrowRight className="w-4 h-4 me-1.5" />
        {tr("teacher.225")}
      </Button>

      {ws.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : ws.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center space-y-3">
          <p className="text-sm font-medium text-destructive">{tr("teacher.291")}</p>
          <p className="text-xs text-muted-foreground">{(ws.error as Error)?.message}</p>
          <Button variant="outline" onClick={() => ws.refetch()}>
            <RefreshCw className="w-4 h-4 me-1.5" />
            {tr("teacher.220")}
          </Button>
        </div>
      ) : ws.data ? (
        <WorkspaceBody ws={ws.data} refresh={refresh} />
      ) : null}
    </motion.div>
  );
}

// ------------------------------------------------------------
// 2.1 Session overview
// ------------------------------------------------------------
function WorkspaceBody({ ws, refresh }: { ws: Workspace; refresh: () => void }) {
  const tr = useT();
  return (
    <>
      {/* 1 — Overview (READ-ONLY lifecycle) */}
      <SectionCard
        title={tr("teacher.226")}
        action={
          ws.lesson.archived ? (
            <Badge variant="secondary" className="gap-1">
              <Lock className="w-3 h-3" />
              {tr("teacher.295")}
            </Badge>
          ) : undefined
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {ws.lesson.officialCode && (
            <Badge variant="outline" className="font-mono text-[10px]" dir="ltr">
              {ws.lesson.officialCode}
            </Badge>
          )}
          <h2 className="text-lg font-bold">{ws.lesson.title}</h2>
          <TrackScopeBadge scope={ws.lesson.trackScope} />
          {ws.lesson.archived ? (
            <CurriculumBadge value="ARCHIVED" />
          ) : (
            <StatusBadge status={ws.lesson.status} />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{ws.lesson.course.name}</span>
          <span>·</span>
          <span>
            {tr("teacher.178")}: {ws.lesson.part.title}
          </span>
          <span>·</span>
          <span>
            {tr("teacher.179")}: {ws.lesson.unit.title}
          </span>
        </div>
        {/* Lifecycle is the admin ceremony's — read-only notice, deliberate. */}
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          <Lock className="me-1 inline h-3.5 w-3.5" aria-hidden="true" />
          {tr("teacher.228")}
        </p>
      </SectionCard>

      {/* 2 — Video status (READ-ONLY) */}
      <VideoStatusCard ws={ws} />

      {/* 3 — Materials (manage-own) */}
      <MaterialsCard ws={ws} refresh={refresh} />

      {/* 4 — Quiz */}
      <QuizzesCard ws={ws} refresh={refresh} />

      {/* 5 — Homework */}
      <HomeworkCard ws={ws} refresh={refresh} />

      {/* 6 — Readiness summary (server snapshot, read-only) */}
      <SectionCard title={tr("teacher.265")}>
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          <Video className="me-1 inline h-3.5 w-3.5" aria-hidden="true" />
          {tr("teacher.266")}
        </p>
        <ReadinessChecklist readiness={ws.readiness} />
      </SectionCard>
    </>
  );
}

// ------------------------------------------------------------
// 2.2 Video status — strictly read-only
// ------------------------------------------------------------
function VideoStatusCard({ ws }: { ws: Workspace }) {
  const tr = useT();
  const v = ws.video;
  return (
    <SectionCard
      title={tr("admin.380")}
      action={
        <Badge variant="outline" className="gap-1 text-[10px]">
          <Lock className="w-3 h-3" />
          {tr("teacher.229")}
        </Badge>
      }
    >
      <div className="flex items-start gap-2.5">
        <ReadinessStateIcon state={v.indicator.state} />
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              {tr("teacher.231")}: <span className="font-bold tabular-nums" dir="ltr">{v.publishedCount}</span>
            </span>
            {v.unpublishedCount > 0 && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {tr("teacher.232")}: <span className="tabular-nums" dir="ltr">{v.unpublishedCount}</span>
                </span>
              </>
            )}
          </div>
          {/* Audience coverage (ARABIC/LANGUAGE rows only for SHARED lessons) */}
          {v.audience.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">{tr("teacher.233")}:</span>
              {v.audience.map((a) => (
                <Badge
                  key={a.track}
                  variant="outline"
                  className={`gap-1 text-[10px] ${
                    a.published
                      ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                      : "border-amber-500/30 text-amber-700 dark:text-amber-300"
                  }`}
                >
                  <TrackScopeBadge scope={a.track} />
                  {a.published ? tr("teacher.296") : tr("teacher.297")}
                </Badge>
              ))}
            </div>
          )}
          {(v.indicator.state === "MISSING" || v.indicator.state === "INVALID") && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] font-medium text-amber-800 dark:text-amber-300">
              {tr("teacher.230")}
            </p>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ------------------------------------------------------------
// 2.3 Materials — Phase 14 storage, Phase E manage-own rules
// ------------------------------------------------------------
function MaterialsCard({ ws, refresh }: { ws: Workspace; refresh: () => void }) {
  const tr = useT();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [scope, setScope] = React.useState(""); // "" = inherit the lesson's
  const [target, setTarget] = React.useState<MaterialRow | null>(null);
  const uploader = useMediaUpload();

  // Phase 23/Phase E — the upload follows the PRODUCTION architecture:
  // bytes go browser → private R2 via a short-lived presigned PUT issued by
  // the TEACHER init endpoint (never the admin one), then the teacher
  // completion verifies the object and finalizes the rows with manage-own
  // scoping. On deployments whose active backend cannot presign
  // (MEDIA_BACKEND=local) the server answers PRESIGNED_UNSUPPORTED and the
  // SECOND argument transparently falls back to the buffered teacher
  // endpoint — the same validation/rules, through the app server.
  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error(tr("teacher.238"));
      const customTitle = title.trim();
      const explicitScope = scope || null;
      const res = await uploader.run(
        {
          purpose: "LESSON_PDF",
          file,
          initEndpoint: "/api/teacher/media-uploads/init",
          completeEndpoint: "/api/teacher/media-uploads/complete",
          initFields: { lessonId: ws.lesson.id },
          completeFields: {
            ...(customTitle ? { title: customTitle } : {}),
            // "" stays ABSENT — the server inherits the lesson's scope.
            ...(explicitScope ? { trackScope: explicitScope } : {}),
          },
          prepare: async () => ({ sha256: await sha256HexOfFile(file) }),
        },
        async (target) => {
          const form = new FormData();
          form.append("file", target);
          if (customTitle) form.append("title", customTitle);
          if (explicitScope) form.append("trackScope", explicitScope);
          const r = await fetch(
            `/api/teacher/sessions/${encodeURIComponent(ws.lesson.id)}/materials`,
            { method: "POST", body: form }
          );
          if (!r.ok) {
            const e = await r.json().catch(() => ({}));
            return { ok: false as const, status: r.status, error: e.error || "fail" };
          }
          return { ok: true as const };
        }
      );
      if (!res.ok) {
        // duplicate/cancelled states exist on the hook — treat cancel silently.
        if ("cancelled" in res && res.cancelled) return "cancelled";
        throw new Error(
          "failure" in res && res.failure
            ? uploadFailureMessage(res.failure, tr)
            : tr("teacher.030")
        );
      }
      return "ok";
    },
    onSuccess: (result) => {
      if (result !== "ok") return;
      toast.success(tr("teacher.245"));
      setFile(null);
      setTitle("");
      setScope("");
      if (inputRef.current) inputRef.current.value = "";
      uploader.reset();
      refresh();
    },
    onError: (e: Error) => toast.error(e.message || tr("teacher.030")),
  });
  const uploading = uploader.isBusy || upload.isPending;
  const uploadPercent = uploader.state.computable ? uploader.state.percent : null;

  const deactivate = useMutation({
    mutationFn: async (materialId: string) => {
      const r = await fetch(
        `/api/teacher/sessions/${encodeURIComponent(ws.lesson.id)}/materials?materialId=${encodeURIComponent(materialId)}`,
        { method: "DELETE" }
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.244"));
      setTarget(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message || tr("teacher.030")),
  });

  const canUpload = !uploading && !ws.lesson.archived && !!file;

  return (
    <SectionCard title={tr("teacher.234")}>
      {/* Upload row */}
      {!ws.lesson.archived && (
        <div className="rounded-lg border border-dashed p-3 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={uploading}
              className="h-9 w-full sm:w-auto sm:flex-1 file:me-2 file:rounded file:border-0 file:bg-muted file:px-2 file:py-0.5 file:text-xs"
              aria-label={tr("teacher.238")}
            />
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={tr("teacher.237")}
              disabled={uploading}
              className="h-9 w-full sm:w-44"
            />
            <div className="w-full sm:w-44">
              <TrackScopeSelect
                value={scope}
                onChange={setScope}
                disabled={uploading}
                inheritLabelKey="teacher.290"
              />
            </div>
            <Button
              onClick={() => upload.mutate()}
              disabled={!canUpload}
              className="w-full sm:w-auto"
            >
              {uploading && <Loader2 className="w-4 h-4 me-1.5 animate-spin" />}
              {!uploading && <Upload className="w-4 h-4 me-1.5" />}
              {uploading ? tr("teacher.236") : tr("teacher.235")}
            </Button>
          </div>
          {uploading && (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={uploadPercent ?? undefined}
            >
              <div
                className={`h-full bg-primary transition-all ${
                  uploadPercent == null ? "w-1/3 animate-pulse" : ""
                }`}
                style={uploadPercent != null ? { width: `${uploadPercent}%` } : undefined}
              />
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">{tr("teacher.299")}</p>
        </div>
      )}

      {/* List */}
      {ws.materials.length === 0 && !ws.lesson.legacyPdfUrl ? (
        <div className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          {tr("teacher.239")}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {ws.lesson.legacyPdfUrl && (
            <li className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-xs">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">{tr("teacher.300")}</span>
              <Badge variant="secondary" className="text-[10px]">
                {tr("admin.347")}
              </Badge>
            </li>
          )}
          {ws.materials.map((m) => (
            <li
              key={m.id}
              className={`flex flex-wrap items-center gap-2 rounded-lg border p-2.5 text-xs ${
                m.isActive ? "" : "opacity-70"
              }`}
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate font-medium">{m.title}</span>
              <TrackScopeBadge scope={m.trackScope} />
              <Badge
                variant={m.own ? "outline" : "secondary"}
                className="text-[10px]"
              >
                {m.own ? tr("teacher.240") : tr("teacher.241")}
              </Badge>
              <Badge
                variant="outline"
                className={`text-[10px] ${
                  m.isActive
                    ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                    : ""
                }`}
              >
                {m.isActive ? tr("teacher.248") : tr("teacher.249")}
              </Badge>
              <span className="text-muted-foreground">
                {m.sizeBytes ? formatBytes(m.sizeBytes) : ""} · {shortDate(String(m.createdAt))}
              </span>
              <span className="ms-auto flex items-center gap-1">
                {m.downloadUrl && (
                  <Button variant="ghost" size="sm" asChild className="h-7 px-2">
                    <a href={m.downloadUrl} target="_blank" rel="noopener noreferrer">
                      {tr("teacher.250")}
                    </a>
                  </Button>
                )}
                {m.own && m.isActive && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-destructive"
                    onClick={() => setTarget(m)}
                    aria-label={tr("teacher.246")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={!!target}
        onOpenChange={(v) => !v && setTarget(null)}
        title={tr("teacher.242")}
        description={tr("teacher.243")}
        confirmLabel={tr("teacher.246")}
        confirmingLabel={tr("teacher.247")}
        confirming={deactivate.isPending}
        danger
        onConfirm={() => target && deactivate.mutate(target.id)}
      />
    </SectionCard>
  );
}

// ------------------------------------------------------------
// 2.4 Quiz — create / edit metadata / question manager / delete
// ------------------------------------------------------------
function QuizzesCard({ ws, refresh }: { ws: Workspace; refresh: () => void }) {
  const tr = useT();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [manageQuiz, setManageQuiz] = React.useState<QuizRow | null>(null);
  const [editQuiz, setEditQuiz] = React.useState<QuizRow | null>(null);
  const [deleteQuiz, setDeleteQuiz] = React.useState<QuizRow | null>(null);
  const [previewQuizId, setPreviewQuizId] = React.useState<string | null>(null);
  const [attemptsQuizId, setAttemptsQuizId] = React.useState<string | null>(null);

  const publish = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/teacher/quizzes/${encodeURIComponent(id)}/publish`, { method: "POST" });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "تعذر النشر"); }
      return r.json();
    },
    onSuccess: () => { toast.success("تم نشر الاختبار"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const duplicate = useMutation({
    mutationFn: async (id: string) => { const r = await fetch(`/api/teacher/quizzes/${encodeURIComponent(id)}/duplicate`, { method: "POST" }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "تعذر نسخ الاختبار"); return r.json(); },
    onSuccess: (data: any) => { const title = data?.quiz?.titleAr || data?.quiz?.title || "الاختبار"; toast.success(`تم إنشاء نسخة جديدة كمسودة: ${title}`); refresh(); }, onError: (e: Error) => toast.error(e.message),
  });
  const preview = (id: string) => setPreviewQuizId(id);

  const del = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/teacher/quizzes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.260"));
      setDeleteQuiz(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message || tr("teacher.030")),
  });

  return (
    <SectionCard
      title={tr("admin.382")}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCreateOpen(true)}
          disabled={ws.lesson.archived}
        >
          <Plus className="w-4 h-4 me-1" />
          {tr("teacher.252")}
        </Button>
      }
    >
      {ws.quizzes.length === 0 ? (
        <div className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          {tr("teacher.253")}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {ws.quizzes.map((q) => (
            <li key={q.id} className="rounded-lg border p-2.5 text-xs space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate font-medium">{q.title}</span>
                <Badge variant="outline" className={`text-[10px] ${lifecycleTone(q.status)}`}>
                  {lifecycleLabel(q.status)}
                </Badge>
                <TrackScopeBadge scope={q.trackScope} />
                <span className="text-muted-foreground">
                  {tr("teacher.267")}: {q.passMark}٪
                </span>
                {q.timeLimit != null && (
                  <Badge variant="outline" className="text-[10px]" dir="ltr">
                    {tr("teacher.175")}: {q.timeLimit}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={`gap-1 text-[10px] ${
                    q.questionCount > 0
                      ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
                      : "border-amber-500/30 text-amber-700 dark:text-amber-300"
                  }`}
                >
                  {q.questionCount} {tr("teacher.254")}
                  {q.questionCount === 0 && (
                    <AlertTriangle className="w-3 h-3" aria-label={tr("teacher.293")} />
                  )}
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {q.attemptsCount} {tr("teacher.255")}
                </Badge>
                {q.questionCount === 0 && (
                  <Badge variant="outline" className="border-amber-500/30 text-[10px] text-amber-700 dark:text-amber-300">
                    {tr("teacher.293")}
                  </Badge>
                )}
                <span className="ms-auto flex items-center gap-1">
                  <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => preview(q.id)}>معاينة</Button>
                  {q.attemptsCount > 0 && <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => duplicate.mutate(q.id)} disabled={duplicate.isPending}>نسخ الاختبار</Button>}
                  {q.attemptsCount > 0 && <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setAttemptsQuizId(q.id)}>عرض المحاولات</Button>}
                  {q.status === "DRAFT" && q.questionCount > 0 && (
                    <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => publish.mutate(q.id)} disabled={publish.isPending}>
                      نشر
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => setManageQuiz(q)}
                  >
                    {tr("teacher.192")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => setEditQuiz(q)}
                  >
                    <Pencil className="me-1 h-3.5 w-3.5" />
                    {tr("teacher.194")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-destructive"
                    onClick={() => setDeleteQuiz(q)}
                    aria-label={tr("teacher.257")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <QuizAttemptsDialog id={attemptsQuizId} open={!!attemptsQuizId} onOpenChange={(v) => !v && setAttemptsQuizId(null)} />
      <QuizPreviewDialog id={previewQuizId} open={!!previewQuizId} onOpenChange={(v) => !v && setPreviewQuizId(null)} />

      {/* Create (metadata + at least one question — the API contract) */}
      <QuizCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        ws={ws}
        refresh={refresh}
      />

      {/* Question management (questions have their own frozen-attempt locks) */}
      {manageQuiz && (
        <QuestionManagerDialog
          quizId={manageQuiz.id}
          quizTitle={manageQuiz.title}
          open={!!manageQuiz}
          onOpenChange={(v) => !v && setManageQuiz(null)}
          onChanged={refresh}
        />
      )}

      {/* Phase E — quiz metadata edit */}
      {editQuiz && (
        <QuizEditDialog
          key={editQuiz.id}
          quiz={editQuiz}
          lessonScope={ws.lesson.trackScope}
          open={!!editQuiz}
          onOpenChange={(v) => !v && setEditQuiz(null)}
          onSaved={refresh}
        />
      )}

      <ConfirmDialog
        open={!!deleteQuiz}
        onOpenChange={(v) => !v && setDeleteQuiz(null)}
        title={tr("teacher.257")}
        description={`${deleteQuiz?.title ?? ""} — ${tr("teacher.258")}`}
        confirmLabel={tr("teacher.246")}
        confirmingLabel={tr("teacher.247")}
        confirming={del.isPending}
        danger
        onConfirm={() => deleteQuiz && del.mutate(deleteQuiz.id)}
      />
    </SectionCard>
  );
}

function QuizAttemptsDialog({ id, open, onOpenChange }: { id: string | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [data, setData] = React.useState<any>(null); const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (!open || !id) return; let live=true; setData(null); setError(null); fetch(`/api/teacher/quizzes/${encodeURIComponent(id)}/attempts`).then(async r => { const b=await r.json(); if(!r.ok) throw new Error(b.error||"تعذر تحميل النتائج"); return b; }).then(b=>live&&setData(b)).catch(e=>live&&setError(e.message)); return ()=>{live=false}; },[id,open]);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto" dir="rtl"><DialogHeader><DialogTitle>نتائج الطلاب</DialogTitle></DialogHeader>{!data&&!error&&<div className="py-10 text-center text-muted-foreground">جارٍ التحميل…</div>}{error&&<p className="text-destructive">{error}</p>}{data&&(!data.attempts?.length?<p className="py-8 text-center text-muted-foreground">لا توجد محاولات بعد</p>:<div className="space-y-2">{data.attempts.map((a:any,i:number)=><div key={a.id||i} className="rounded border p-3 flex flex-wrap gap-3 items-center"><strong>{a.student?.name || "طالب"}</strong><span>المحاولة {a.attemptNumber}</span><span>{a.score ?? 0}/{a.totalMarks ?? 0}</span><span>{a.percentage ?? 0}%</span><Badge variant="outline">{a.passed ? "ناجح" : "غير ناجح"}</Badge><span className="text-muted-foreground text-xs">{a.finishedAt ? new Date(a.finishedAt).toLocaleString("ar-EG") : "مفتوحة"}</span></div>)}</div>)}<DialogFooter><Button variant="outline" onClick={()=>onOpenChange(false)}>إغلاق</Button></DialogFooter></DialogContent></Dialog>;
}

function QuizPreviewDialog({ id, open, onOpenChange }: { id: string | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [data, setData] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open || !id) return;
    let alive = true; setData(null); setError(null);
    fetch(`/api/teacher/quizzes/${encodeURIComponent(id)}/preview`)
      .then(async (r) => { const body = await r.json(); if (!r.ok) throw new Error(body.error || "تعذر فتح المعاينة"); return body.preview; })
      .then((v) => alive && setData(v)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [id, open]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto" dir="rtl">
      <DialogHeader><DialogTitle>معاينة الاختبار</DialogTitle><DialogDescription>معاينة مدرسية لا تنشئ محاولة للطالب</DialogDescription></DialogHeader>
      {!data && !error && <div className="py-12 text-center text-muted-foreground">جارٍ تحميل المعاينة…</div>}
      {error && <div className="rounded border border-destructive/30 p-4 text-destructive">{error}</div>}
      {data && <div className="space-y-4">
        <div className="rounded-lg border p-4 space-y-2"><h3 className="font-semibold">{data.quiz.title}</h3><p className="text-sm text-muted-foreground">{data.quiz.description || "لا يوجد وصف"}</p><div className="flex flex-wrap gap-2 text-xs"><Badge variant="outline">{data.quiz.status === "DRAFT" ? "مسودة" : "منشور"}</Badge><Badge variant="outline">درجة النجاح: {data.quiz.passMark}</Badge><Badge variant="outline">المدة: {data.quiz.timeLimit ?? "بدون حد"}</Badge><Badge variant="outline">الأسئلة: {data.quiz.questionCount}</Badge><Badge variant="outline">الدرجة الكلية: {data.quiz.totalMarks}</Badge></div></div>
        {data.questions?.length === 0 ? <div className="p-8 text-center text-muted-foreground">لا توجد أسئلة للمعاينة</div> : data.questions.map((q: any, i: number) => <div key={q.id || i} className="rounded-lg border p-4 space-y-2"><div className="flex justify-between text-xs text-muted-foreground"><span>سؤال {i + 1} · {q.type === "MCQ" ? "اختيار من متعدد" : q.type === "TRUE_FALSE" ? "صح أو خطأ" : "سؤال"}</span><span>{q.marks} درجة · {q.difficulty === "EASY" ? "سهل" : q.difficulty === "HARD" ? "صعب" : "متوسط"}</span></div><p className="font-medium">{q.promptAr || q.prompt}</p><div className="grid gap-2 sm:grid-cols-2">{(Array.isArray(q.options) ? q.options : []).map((o: string, j: number) => <div key={j} className={`rounded border p-2 ${String(q.answer) === String(j) ? "border-emerald-500 bg-emerald-500/10" : ""}`}>{o}</div>)}</div></div>)}
      </div>}
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>إغلاق</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

// ------------------------------------------------------------
// Quiz create — lesson is FIXED to the workspace session
// ------------------------------------------------------------
type QuestionDraft = {
  type: "MCQ" | "TRUE_FALSE";
  prompt: string;
  promptAr: string;
  options: string[];
  answer: string;
  explanation: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
};

function emptyQuestion(): QuestionDraft {
  return {
    type: "MCQ",
    prompt: "",
    promptAr: "",
    options: ["", "", "", ""],
    answer: "0",
    explanation: "",
    difficulty: "MEDIUM",
    marks: 1,
  };
}

function QuizCreateDialog({
  open,
  onOpenChange,
  ws,
  refresh,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  ws: Workspace;
  refresh: () => void;
}) {
  const tr = useT();
  const [title, setTitle] = React.useState("");
  const [titleAr, setTitleAr] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [passMark, setPassMark] = React.useState(60);
  const [timeLimit, setTimeLimit] = React.useState<string>("");
  const [trackScope, setTrackScope] = React.useState("");
  const [cameraPolicy, setCameraPolicy] = React.useState<"OPTIONAL" | "REQUIRED">("OPTIONAL");
  const [questions, setQuestions] = React.useState<QuestionDraft[]>([emptyQuestion()]);

  const mutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const r = await fetch("/api/teacher/quizzes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.053"));
      onOpenChange(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message || tr("teacher.030")),
  });

  const updateQ = (idx: number, patch: Partial<QuestionDraft>) =>
    setQuestions((qs) => qs.map((q, i) => (i === idx ? { ...q, ...patch } : q)));

  const submit = () => {
    if (!title.trim()) return toast.error(tr("teacher.077"));
    if (questions.length === 0) return toast.error(tr("teacher.078"));
    // Same normalization as the legacy Quizzes tab: TRUE_FALSE carries the
    // canonical pair; MCQ drops blank options; absent question track tags are
    // sent as ABSENT (no client substitution — teacher.203 semantics).
    const normalized = questions.map((q) =>
      q.type === "TRUE_FALSE"
        ? { ...q, options: ["True", "False"], answer: q.answer === "1" ? "1" : "0" }
        : {
            ...q,
            options: q.options.filter((o) => o.trim() !== ""),
            answer: q.answer || "0",
          }
    );
    for (let i = 0; i < normalized.length; i++) {
      const q = normalized[i];
      if (!q.prompt.trim()) return toast.error(tr("teacher.079", { p1: i + 1 }));
      if (q.type === "MCQ" && q.options.length < 2) {
        return toast.error(tr("teacher.080", { p1: i + 1 }));
      }
    }
    mutation.mutate({
      lessonId: ws.lesson.id,
      title: title.trim(),
      titleAr: titleAr.trim() || title.trim(),
      description: description.trim(),
      passMark,
      timeLimit: timeLimit.trim() === "" ? null : Number(timeLimit),
      trackScope,
      cameraPolicy,
      questions: normalized.map((q) => ({ ...q, schoolType: undefined })),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("teacher.252")}</DialogTitle>
          <DialogDescription>{ws.lesson.title}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {tr("teacher.269")} <span className="text-destructive">*</span>
              </Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} dir="ltr" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.270")}</Label>
              <Input value={titleAr} onChange={(e) => setTitleAr(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{tr("teacher.271")}</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="space-y-1.5 rounded-lg border p-3">
            <Label className="text-xs text-muted-foreground">الكاميرا أثناء الاختبار</Label>
            <Select value={cameraPolicy} onValueChange={(v) => setCameraPolicy(v as "OPTIONAL" | "REQUIRED")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="OPTIONAL">اختيارية</SelectItem><SelectItem value="REQUIRED">مطلوبة</SelectItem></SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">تحدد هل يجب السماح بالكاميرا قبل بدء المحاولة.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.267")}</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={passMark}
                onChange={(e) => setPassMark(Number(e.target.value))}
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.175")}</Label>
              <Input
                type="number"
                min={1}
                max={300}
                value={timeLimit}
                onChange={(e) => setTimeLimit(e.target.value)}
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.289")}</Label>
              <TrackScopeSelect value={trackScope} onChange={setTrackScope} inheritLabelKey="teacher.290" />
            </div>
          </div>

          {/* Questions */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-bold">{tr("teacher.192")}</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setQuestions((qs) => [...qs, emptyQuestion()])}
              >
                <Plus className="w-3.5 h-3.5 me-1" />
                {tr("teacher.287")}
              </Button>
            </div>
            {questions.map((q, idx) => (
              <QuestionDraftEditor
                key={idx}
                index={idx}
                draft={q}
                onChange={(patch) => updateQ(idx, patch)}
                onRemove={() => setQuestions((qs) => qs.filter((_, i) => i !== idx))}
                removable={questions.length > 1}
              />
            ))}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {tr("admin.288")}
          </Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="w-4 h-4 me-1.5 animate-spin" />}
            {tr("teacher.252")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuestionDraftEditor({
  index,
  draft,
  onChange,
  onRemove,
  removable,
}: {
  index: number;
  draft: QuestionDraft;
  onChange: (patch: Partial<QuestionDraft>) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  const tr = useT();
  return (
    <div className="rounded-lg border p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px]">
          {index + 1}
        </Badge>
        <Select
          value={draft.type}
          onValueChange={(v) => onChange({ type: v as QuestionDraft["type"] })}
        >
          <SelectTrigger className="h-8 w-40" aria-label={tr("teacher.277")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="MCQ">{tr("teacher.278")}</SelectItem>
            <SelectItem value="TRUE_FALSE">{tr("teacher.279")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={draft.difficulty}
          onValueChange={(v) => onChange({ difficulty: v as QuestionDraft["difficulty"] })}
        >
          <SelectTrigger className="h-8 w-32" aria-label={tr("teacher.286")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="EASY">{tr("teacher.283")}</SelectItem>
            <SelectItem value="MEDIUM">{tr("teacher.284")}</SelectItem>
            <SelectItem value="HARD">{tr("teacher.285")}</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Label className="text-[11px] text-muted-foreground">{tr("teacher.282")}</Label>
          <Input
            type="number"
            min={1}
            max={100}
            value={draft.marks}
            onChange={(e) => onChange({ marks: Number(e.target.value) })}
            className="h-8 w-16"
            dir="ltr"
          />
        </div>
        {removable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ms-auto h-7 px-2 text-destructive"
            onClick={onRemove}
            aria-label={tr("teacher.288")}
          >
            <XCircle className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Input
        value={draft.prompt}
        onChange={(e) => onChange({ prompt: e.target.value })}
        placeholder={tr("teacher.273")}
        aria-label={tr("teacher.273")}
      />

      {draft.type === "MCQ" ? (
        <div className="space-y-1.5">
          {draft.options.map((opt, oi) => (
            <div key={oi} className="flex items-center gap-2">
              <input
                type="radio"
                name={`wsq-${index}`}
                checked={draft.answer === String(oi)}
                onChange={() => onChange({ answer: String(oi) })}
                className="h-3.5 w-3.5 accent-primary"
                aria-label={`${tr("teacher.195")} ${oi + 1}`}
              />
              <Input
                value={opt}
                onChange={(e) =>
                  onChange({
                    options: draft.options.map((o, i) => (i === oi ? e.target.value : o)),
                  })
                }
                placeholder={tr("teacher.274", { p1: oi + 1 })}
                className="h-8"
              />
              {draft.options.length > 2 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-muted-foreground"
                  onClick={() => {
                    const next = draft.options.filter((_, i) => i !== oi);
                    const answer = Number(draft.answer);
                    onChange({
                      options: next,
                      answer: answer === oi ? "0" : answer > oi ? String(answer - 1) : draft.answer,
                    });
                  }}
                  aria-label={tr("teacher.288")}
                >
                  <XCircle className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
          {draft.options.length < 10 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => onChange({ options: [...draft.options, ""] })}
            >
              <Plus className="h-3.5 w-3.5 me-1" />
              {tr("teacher.275")}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-4">
          {[["0", tr("teacher.280")], ["1", tr("teacher.281")]].map(([val, label]) => (
            <label key={val} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name={`wsq-${index}`}
                checked={draft.answer === val}
                onChange={() => onChange({ answer: val })}
                className="h-3.5 w-3.5 accent-primary"
              />
              {label}
            </label>
          ))}
        </div>
      )}

      <Input
        value={draft.explanation}
        onChange={(e) => onChange({ explanation: e.target.value })}
        placeholder={tr("teacher.294")}
        className="h-8"
      />
    </div>
  );
}

// ------------------------------------------------------------
// Quiz metadata edit (Phase E PATCH)
// ------------------------------------------------------------
function QuizEditDialog({
  quiz,
  lessonScope,
  open,
  onOpenChange,
  onSaved,
}: {
  quiz: QuizRow;
  lessonScope: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const tr = useT();
  const [title, setTitle] = React.useState(quiz.titleRaw);
  const [titleAr, setTitleAr] = React.useState(quiz.titleAr ?? "");
  const [description, setDescription] = React.useState(quiz.description ?? "");
  const [passMark, setPassMark] = React.useState(quiz.passMark);
  const [timeLimit, setTimeLimit] = React.useState<string>(
    quiz.timeLimit != null ? String(quiz.timeLimit) : ""
  );
  const [trackScope, setTrackScope] = React.useState(quiz.trackScope);

  const mutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/teacher/quizzes/${encodeURIComponent(quiz.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          titleAr: titleAr.trim(),
          description: description.trim(),
          passMark: Number(passMark),
          timeLimit: timeLimit.trim() === "" ? null : Number(timeLimit),
          trackScope,
        }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.259"));
      onOpenChange(false);
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message || tr("teacher.030")),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr("teacher.256")}</DialogTitle>
          <DialogDescription>{quiz.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.269")}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} dir="ltr" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.270")}</Label>
              <Input value={titleAr} onChange={(e) => setTitleAr(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{tr("teacher.271")}</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.267")}</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={passMark}
                onChange={(e) => setPassMark(Number(e.target.value))}
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.175")}</Label>
              <Input
                type="number"
                min={1}
                max={300}
                value={timeLimit}
                onChange={(e) => setTimeLimit(e.target.value)}
                dir="ltr"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.289")}</Label>
              {quiz.attemptsCount > 0 ? (
                // Frozen audience: the server refuses moves once attempts
                // exist (api.321); the control is disabled instead of
                // pretending the refusal is a surprise.
                <div className="flex h-9 items-center gap-1.5 rounded-md border bg-muted/40 px-2 text-xs text-muted-foreground">
                  <Lock className="h-3.5 w-3.5" />
                  <TrackScopeBadge scope={quiz.trackScope} />
                </div>
              ) : (
                <Select value={trackScope} onValueChange={setTrackScope}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["SHARED", "ARABIC", "LANGUAGE"]
                      .filter(
                        (v) =>
                          // Only scopes the lesson can host are offered; the
                          // server re-checks regardless (api.243).
                          v === "SHARED" ||
                          lessonScope === "SHARED" ||
                          lessonScope === v
                      )
                      .map((v) => (
                        <SelectItem key={v} value={v}>
                          {v === "SHARED"
                            ? tr("admin.349")
                            : v === "ARABIC"
                              ? tr("admin.350")
                              : tr("admin.351")}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            {tr("admin.288")}
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="w-4 h-4 me-1.5 animate-spin" />}
            {tr("teacher.272")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// 2.5 Homework — create / edit (shared dialog) / guarded delete
// ------------------------------------------------------------
function HomeworkCard({ ws, refresh }: { ws: Workspace; refresh: () => void }) {
  const tr = useT();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<HomeworkRecord | null>(null);
  const [deleting, setDeleting] = React.useState<HomeworkRow | null>(null);

  const transition = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: "publish" | "close" }) => {
      const r = await fetch(`/api/teacher/homework/${encodeURIComponent(id)}/${action}`, { method: "POST" });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "تعذر تحديث حالة الواجب"); }
      return r.json();
    },
    onSuccess: (_data, vars) => { toast.success(vars.action === "publish" ? "تم نشر الواجب" : "تم إغلاق الواجب"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/teacher/homework/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.264"));
      setDeleting(null);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message || tr("teacher.030")),
  });

  // The shared HomeworkDialog needs the picker catalogue; the workspace
  // scopes it to THIS lesson only, so the lesson can never drift.
  const dialogLessons = React.useMemo(
    () => [
      {
        id: ws.lesson.id,
        title: ws.lesson.title,
        titleRaw: ws.lesson.titleRaw,
        titleAr: ws.lesson.titleAr ?? ws.lesson.titleRaw,
        order: ws.lesson.order,
        officialCode: ws.lesson.officialCode,
        trackScope: ws.lesson.trackScope,
        status: ws.lesson.status,
        curriculumStatus: ws.lesson.curriculumStatus,
        archived: ws.lesson.archived,
        chain: ws.lesson.chain,
        course: ws.lesson.course,
        part: { id: ws.lesson.part.id, title: ws.lesson.part.title, order: ws.lesson.part.order },
        unit: { id: ws.lesson.unit.id, title: ws.lesson.unit.title, order: ws.lesson.unit.order },
        topic: null,
      },
    ],
    [ws.lesson]
  );

  const asRecord = (h: HomeworkRow): HomeworkRecord => ({
    id: h.id,
    lessonId: h.lessonId,
    title: h.titleRaw,
    titleAr: h.titleAr ?? "",
    instructions: h.instructions,
    deadline: h.deadline,
    maxMarks: h.maxMarks,
    trackScope: h.trackScope,
    gradedCount: h.gradedCount,
  });

  return (
    <SectionCard
      title={tr("shell.004")}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
          disabled={ws.lesson.archived}
        >
          <Plus className="w-4 h-4 me-1" />
          {tr("teacher.261")}
        </Button>
      }
    >
      {ws.homework.length === 0 ? (
        <div className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          {tr("teacher.301")}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {ws.homework.map((h) => (
            <li key={h.id} className="rounded-lg border p-2.5 text-xs space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate font-medium">{h.title}</span>
                <Badge variant="outline" className={`text-[10px] ${lifecycleTone(h.status)}`}>
                  {lifecycleLabel(h.status, true)}
                </Badge>
                <TrackScopeBadge scope={h.trackScope} />
                {!h.instructions?.trim() && (
                  <Badge
                    variant="outline"
                    className="gap-1 border-amber-500/30 text-[10px] text-amber-700 dark:text-amber-300"
                  >
                    <AlertTriangle className="w-3 h-3" />
                    {tr("teacher.292")}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span>
                  {tr("teacher.185")}: {shortDate(h.deadline)} · {tr("teacher.186")}:{" "}
                  <span className="tabular-nums" dir="ltr">
                    {h.maxMarks}
                  </span>
                </span>
                <Badge variant="secondary" className="text-[10px]">
                  {h.submissionsCount} {tr("teacher.255")}
                </Badge>
                {h.gradedCount > 0 && (
                  <Badge variant="secondary" className="text-[10px]">
                    {h.gradedCount} {tr("teacher.302")}
                  </Badge>
                )}
                <span className="ms-auto flex items-center gap-1">
                  {h.status === "DRAFT" && <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => transition.mutate({ id: h.id, action: "publish" })} disabled={transition.isPending}>نشر الواجب</Button>}
                  {h.status === "PUBLISHED" && <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => transition.mutate({ id: h.id, action: "close" })} disabled={transition.isPending}>إغلاق الواجب</Button>}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => {
                      setEditing(asRecord(h));
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="me-1 h-3.5 w-3.5" />
                    {tr("teacher.194")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-destructive"
                    onClick={() => setDeleting(h)}
                    aria-label={tr("teacher.262")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* The shared create/edit dialog — the lesson is scoped to THIS one. */}
      {dialogOpen && (
        <HomeworkDialog
          key={editing?.id ?? "new-homework"}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          lessons={dialogLessons}
          lessonsLoading={false}
          homework={editing ?? undefined}
          onChanged={refresh}
          fixedLessonId={ws.lesson.id}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={tr("teacher.262")}
        description={`${deleting?.title ?? ""} — ${tr("teacher.263")}`}
        confirmLabel={tr("teacher.246")}
        confirmingLabel={tr("teacher.247")}
        confirming={del.isPending}
        danger
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </SectionCard>
  );
}
