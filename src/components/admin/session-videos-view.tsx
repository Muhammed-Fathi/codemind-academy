"use client";

// ============================================================
// CodeMind Academy — Admin: Session Video management
//
// ACADEMIC IDENTITY (Phase A): the Lesson IS the canonical academic session.
// Every NEW video is bound to a Lesson × Batch pair: the Lesson owns the
// content, the Batch (school type) is the audience. The form therefore
// requires a Lesson — chosen from a human-readable, unit-grouped picker —
// and the server re-validates the exact same contract on every creation path
// (presigned, buffered fallback, external URL). Legacy rows without a lesson
// stay readable and deletable and are labelled, never migrated.
//
// Batches are school-type based (Arabic School / Language School). The admin
// opens a batch, picks the lesson, supplies EITHER an uploaded video file OR a
// video URL, and publishes once — the media is stored a single time and
// becomes available to every eligible student of that batch. No per-student
// copies are made.
//
// All spacing/alignment uses logical properties so the layout is correct in
// both Arabic (RTL) and English (LTR).
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useT, useLocale, pickAuto } from "@/lib/i18n";
import {
  AcademicLevelBadge,
  AcademicLevelSegmentedFilter,
  academicLevelLabel,
} from "@/components/admin/academic-level-ui";
import { useApp } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users,
  Upload,
  Link2,
  Video,
  Trash2,
  Loader2,
  CheckCircle2,
  BookOpen,
  AlertTriangle,
  Pencil,
  GraduationCap,
} from "lucide-react";
import { uploadFailureMessage } from "@/lib/upload-error-text";
import {
  buildLessonGroups,
  flattenEligibleLessonIds,
  deepLinkTargetBatch,
  type PickerLesson,
} from "@/lib/session-video-picker";
import { normalizeExternalVideoUrl } from "@/lib/video-url";
import {
  useMediaUpload,
  type MediaUploadResult,
} from "@/hooks/use-media-upload";
import { UploadProgressPanel } from "@/components/admin/upload-progress-panel";

type Batch = {
  id: string;
  name: string;
  nameAr: string;
  schoolType: "ARABIC" | "LANGUAGE";
  course: { id: string; name: string; nameAr: string; academicLevel?: string | null } | null;
  isActive: boolean;
  members: number;
  videos: number;
};

type SessionVideoLesson = {
  id: string;
  title: string;
  titleAr: string;
  officialCode: string | null;
  /** Derived level cache (course chain) — context only. */
  academicLevel?: string | null;
  unit: { id: string; title: string; titleAr: string; order: number } | null;
};

type SessionVideo = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  batch: { id: string; name: string; nameAr: string; schoolType: string };
  /** The academic session this video belongs to (Phase A). null = legacy row. */
  lesson: SessionVideoLesson | null;
  requiredPercent: number;
  isRequiredForProgression: boolean;
  /** Requirement mode + absence-source link (from the GET mapping). */
  requirementMode: string;
  liveSessionId: string | null;
  liveSession: { id: string; title: string; titleAr: string } | null;
  isPublished: boolean;
  publishedAt: string | null;
  source: "URL" | "UPLOAD";
  externalUrl: string | null;
  streamUrl: string | null;
  viewers: number;
};

/** Lessons grouped for the picker — one SelectGroup per group; the label is
    formatted in the component (i18n) from the pure group data. */
type LessonGroupView = {
  key: string;
  label: string;
  lessons: PickerLesson[];
};

type TrFn = (key: string, params?: Record<string, unknown>) => string;

/** "Lesson 1-1 — Variables" (code + title) or just the title when the lesson
    has no official code. Raw ids are never shown to the admin. */
function lessonOptionLabel(l: PickerLesson, tr: TrFn): string {
  const title = pickAuto(l.titleAr, l.title);
  const base = l.officialCode ? `${tr("admin.594", { p1: l.officialCode })} — ${title}` : title;
  // Level + officialCode + title: the same code exists across levels, so the
  // option text always carries the (derived) level.
  return `${academicLevelLabel(tr, l.academicLevel)} · ${base}`;
}

/** The lesson line for a listed video: "Lesson 1-1 — Variables · Unit 1".
    null for legacy rows (they get the "not linked" warning instead). */
function videoLessonLabel(v: SessionVideo, tr: TrFn): string | null {
  if (!v.lesson) return null;
  const title = pickAuto(v.lesson.titleAr, v.lesson.title);
  const name = v.lesson.officialCode
    ? `${tr("admin.594", { p1: v.lesson.officialCode })} — ${title}`
    : title;
  const withUnit = v.lesson.unit ? `${name} · ${tr("admin.593", { p1: v.lesson.unit.order })}` : name;
  return `${academicLevelLabel(tr, v.lesson.academicLevel)} · ${withUnit}`;
}

/** Walk the full course tree (both the canonical unit chain and the legacy
    topic chain) and return the first non-archived lesson with this id. */
function findLessonInTree(
  courses: any[],
  lessonId: string
): { id: string; trackScope: string } | null {
  for (const c of courses) {
    for (const p of c.parts || []) {
      for (const u of p.units || []) {
        const candidates = [
          ...(u.lessons || []),
          ...(u.topics || []).flatMap((t: any) => t.lessons || []),
        ];
        for (const l of candidates) {
          if (l && l.id === lessonId && l.curriculumStatus !== "ARCHIVED") {
            return { id: l.id, trackScope: l.trackScope };
          }
        }
      }
    }
  }
  return null;
}

export function SessionVideosView() {
  const tr = useT();
  const locale = useLocale();

  const [batches, setBatches] = React.useState<Batch[]>([]);
  const [eligible, setEligible] = React.useState<{ ARABIC: number; LANGUAGE: number }>({
    ARABIC: 0,
    LANGUAGE: 0,
  });
  const [activeBatchId, setActiveBatchId] = React.useState<string | null>(null);
  const [videos, setVideos] = React.useState<SessionVideo[]>([]);
  /** The row currently showing the inline edit form (null = none). */
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingVideos, setLoadingVideos] = React.useState(false);

  // Lesson picker data — the full course tree (units → lessons, both chains),
  // fetched once; filtered per active batch below.
  const [courseTree, setCourseTree] = React.useState<any[] | null>(null);
  const [treeError, setTreeError] = React.useState(false);

  const loadBatches = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/batches");
      const d = await r.json();
      setBatches(d.batches || []);
      setEligible(d.eligible || { ARABIC: 0, LANGUAGE: 0 });
      setActiveBatchId((prev) => prev || d.batches?.[0]?.id || null);
    } catch {
      toast.error(tr("admin.001"));
    } finally {
      setLoading(false);
    }
  }, [tr]);

  const loadVideos = React.useCallback(async (batchId: string) => {
    setLoadingVideos(true);
    try {
      const r = await fetch(`/api/admin/session-videos?batchId=${encodeURIComponent(batchId)}`);
      const d = await r.json();
      setVideos(d.videos || []);
    } catch {
      setVideos([]);
    } finally {
      setLoadingVideos(false);
    }
  }, []);

  const loadCourseTree = React.useCallback(async () => {
    setTreeError(false);
    try {
      // tree=1 is required — without it the API omits parts/units/topics/lessons.
      const r = await fetch("/api/admin/courses?tree=1");
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setCourseTree(d.courses || []);
    } catch {
      setTreeError(true);
    }
  }, []);

  React.useEffect(() => {
    loadBatches();
    loadCourseTree();
  }, [loadBatches, loadCourseTree]);

  React.useEffect(() => {
    if (activeBatchId) loadVideos(activeBatchId);
  }, [activeBatchId, loadVideos]);

  // Deep link from the lesson page: ManageVideosButton hands over the lesson
  // id via navParam (setView clears it, so the button sets it AFTER the view).
  // Once the picker data is ready, preselect that lesson — switching the
  // batch to the lesson's track when the lesson is track-specific and that
  // batch exists. The param is consumed once; nothing is preselected that
  // the picker cannot show (archived lessons are never offered).
  const navParam = useApp((s) => s.navParam);
  const setNavParam = useApp((s) => s.setNavParam);
  const [preselectLessonId, setPreselectLessonId] = React.useState<string | null>(null);
  // Phase L manual-QA fix — the ACADEMIC LEVEL switch for the lesson/session
  // picker: [ الكل ] [ أولى ثانوي ] [ ثانية ثانوي ]. "" = all levels. The
  // value is a canonical AcademicLevel compared against each course's own
  // `Course.academicLevel`; it is a DIFFERENT axis from the Arabic/Language
  // batches above, which stay untouched.
  const [levelFilter, setLevelFilter] = React.useState<string>("");
  React.useEffect(() => {
    if (!navParam || !courseTree || batches.length === 0) return;
    const found = findLessonInTree(courseTree, navParam);
    if (!found) return;
    const target = deepLinkTargetBatch(found.trackScope, batches, activeBatchId);
    if (!target) return; // the lesson's track has no batch — no legal home
    if (target.switchTo && target.switchTo !== activeBatchId) {
      setActiveBatchId(target.switchTo);
    }
    setPreselectLessonId(found.id);
    setNavParam(null);
  }, [navParam, courseTree, batches, activeBatchId, setNavParam]);

  const ensureBatch = async (schoolType: "ARABIC" | "LANGUAGE") => {
    const r = await fetch("/api/admin/batches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schoolType }),
    });
    const d = await r.json();
    if (!r.ok) {
      toast.error(d.error || tr("admin.001"));
      return;
    }
    await loadBatches();
    setActiveBatchId(d.batch.id);
  };

  const activeBatch = batches.find((b) => b.id === activeBatchId) || null;

  // The picker shows ONLY the lessons this batch can legally hold, per the
  // system's batch model: a course-bound batch is scoped to its course; a
  // school-type pool batch spans every course; always non-archived + track
  // fit. The pure logic lives in src/lib/session-video-picker.ts — the
  // server re-validates the final pair on every creation path.
  const lessonGroups = React.useMemo<LessonGroupView[]>(() => {
    if (!courseTree || !activeBatch) return [];
    // Phase L manual-QA fix — the level filter narrows the picker BEFORE any
    // lesson is collected, per course (canonical Course.academicLevel). With
    // both official curricula live (62 First + 23 Second), the unfiltered
    // picker mixed them into one long list whose lessons share codes.
    return buildLessonGroups(courseTree, activeBatch, levelFilter).map((g) => ({
      key: g.key,
      lessons: g.lessons,
      // A pool batch spans courses — disambiguate each unit with its course
      // name so two «الوحدة 1» groups can never be confused.
      // Every group carries its course's LEVEL too (Group→Course→Level):
      // "Course — Level · Unit n" so two «الوحدة 1» in two levels never blur.
      label:
        g.courseName && !activeBatch.course
          ? `${g.courseName} — ${academicLevelLabel(tr, g.courseAcademicLevel)} · ${tr("admin.593", { p1: g.unitOrder })}`
          : `${academicLevelLabel(tr, g.courseAcademicLevel)} · ${tr("admin.593", { p1: g.unitOrder })}`,
    }));
  }, [courseTree, activeBatch, levelFilter, tr]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <div>
        <h2 className="text-xl font-bold">{tr("admin.204")}</h2>
        <p className="text-xs text-muted-foreground">{tr("admin.205")}</p>
      </div>

      {/* Batch selector */}
      {loading ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(["ARABIC", "LANGUAGE"] as const).map((type) => {
            const batch = batches.find((b) => b.schoolType === type);
            const active = batch && batch.id === activeBatchId;
            return (
              <Card
                key={type}
                className={`p-4 transition-colors ${
                  active ? "border-primary ring-1 ring-primary/30" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-bold">
                      {tr(type === "ARABIC" ? "admin.206" : "admin.207")}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Users className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        {tr("admin.213")}: {eligible[type]}
                      </span>
                    </div>
                    {batch && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {batch.videos} · {tr("admin.204")}
                      </div>
                    )}
                  </div>
                  {batch ? (
                    <Button
                      size="sm"
                      variant={active ? "default" : "outline"}
                      onClick={() => setActiveBatchId(batch.id)}
                    >
                      {tr(active ? "admin.211" : "admin.242")}
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => ensureBatch(type)}>
                      {tr("admin.239")}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {activeBatch && (
        <>
          <PublishVideoCard
            batch={activeBatch}
            initialLessonId={preselectLessonId}
            lessonGroups={lessonGroups}
            levelFilter={levelFilter}
            onLevelFilterChange={setLevelFilter}
            lessonsLoading={courseTree === null}
            lessonsError={treeError}
            onRetryLessons={loadCourseTree}
            onPublished={() => {
              loadVideos(activeBatch.id);
              loadBatches();
            }}
          />

          <Card className="p-4">
            <CardHeader className="p-0 pb-3">
              <CardTitle className="text-base flex flex-wrap items-center gap-2">
                <span>{pickAuto(activeBatch.nameAr, activeBatch.name)}</span>
                {activeBatch.course && (
                  <>
                    <span className="text-xs font-normal text-muted-foreground">
                      {pickAuto(activeBatch.course.nameAr, activeBatch.course.name)}
                    </span>
                    <AcademicLevelBadge level={activeBatch.course.academicLevel} />
                  </>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loadingVideos ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-16 w-full rounded-lg" />
                  ))}
                </div>
              ) : videos.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {tr("admin.234")}
                </p>
              ) : (
                <div className="space-y-2">
                  {videos.map((v) => (
                    <div
                      key={v.id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
                    >
                      <div className="grid place-items-center w-9 h-9 shrink-0 rounded-lg bg-primary/10 text-primary">
                        <Video className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">
                          {pickAuto(v.titleAr, v.title)}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          <Badge variant="outline" className="text-[10px]">
                            {v.source === "URL" ? tr("admin.209") : tr("admin.208")}
                          </Badge>
                          {v.lesson ? (
                            <span className="inline-flex items-center gap-1">
                              <BookOpen className="w-3 h-3 shrink-0" />
                              {videoLessonLabel(v, tr)}
                            </span>
                          ) : (
                            // Legacy row (created before Phase A): warn, never
                            // block — the row stays manageable and deletable.
                            <Badge
                              variant="outline"
                              className="text-[10px] border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                            >
                              <AlertTriangle className="w-3 h-3 me-1" />
                              {tr("admin.591")}
                            </Badge>
                          )}
                          <span>
                            {tr("admin.213")}: {v.viewers}
                          </span>
                          <span>· {v.requiredPercent}%</span>
                        </div>
                      </div>
                      <Badge
                        className={
                          v.isPublished
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                            : ""
                        }
                        variant={v.isPublished ? "default" : "secondary"}
                      >
                        {tr(v.isPublished ? "admin.211" : "admin.212")}
                      </Badge>
                      {(v.requirementMode ??
                        (v.isRequiredForProgression ? "ALL_STUDENTS" : "OPTIONAL")) !==
                        "OPTIONAL" && (
                        <Badge
                          variant="outline"
                          className="border-primary/40 bg-primary/10 text-primary text-[10px]"
                        >
                          {tr(
                            v.requirementMode === "ABSENT_STUDENTS"
                              ? "admin.637"
                              : "admin.632"
                          )}
                        </Badge>
                      )}
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={tr("admin.629")}
                          onClick={() =>
                            setEditingId((prev) => (prev === v.id ? null : v.id))
                          }
                        >
                          <Pencil className="w-3.5 h-3.5 me-1" />
                          {tr("admin.629")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            await fetch(`/api/admin/session-videos/${v.id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ isPublished: !v.isPublished }),
                            });
                            loadVideos(activeBatch.id);
                          }}
                        >
                          {tr(v.isPublished ? "admin.243" : "admin.242")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={tr("admin.038")}
                          onClick={async () => {
                            await fetch(`/api/admin/session-videos/${v.id}`, {
                              method: "DELETE",
                            });
                            loadVideos(activeBatch.id);
                            loadBatches();
                          }}
                        >
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                      {editingId === v.id && (
                        <div className="basis-full">
                          <EditVideoForm
                            video={v}
                            onCancel={() => setEditingId(null)}
                            onSaved={() => {
                              setEditingId(null);
                              loadVideos(activeBatch.id);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </motion.div>
  );
}

/** Upload-or-URL publishing form. Both methods are first-class; both are
    bound to the same required lesson (Phase A). */
function PublishVideoCard({
  batch,
  initialLessonId,
  lessonGroups,
  levelFilter,
  onLevelFilterChange,
  lessonsLoading,
  lessonsError,
  onRetryLessons,
  onPublished,
}: {
  batch: Batch;
  /** Set when the admin arrived from a lesson page — preselected once. */
  initialLessonId: string | null;
  /** Already narrowed by the level filter (built in the parent). */
  lessonGroups: LessonGroupView[];
  /** "" = all levels, or a canonical AcademicLevel value. */
  levelFilter: string;
  onLevelFilterChange: (v: string) => void;
  lessonsLoading: boolean;
  lessonsError: boolean;
  onRetryLessons: () => void;
  onPublished: () => void;
}) {
  const tr = useT();
  const [method, setMethod] = React.useState<"UPLOAD" | "URL">("URL");
  const [title, setTitle] = React.useState("");
  const [titleAr, setTitleAr] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [videoUrl, setVideoUrl] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  // Progression requirement: OPTIONAL by default, threshold 95 —
  // the same defaults the server applies when the fields are absent.
  const [requiredPercent, setRequiredPercent] = React.useState("95");
  // Explicit requirement mode + absence-source session (the selector owns
  // both; the legacy REQUIRED toggle is retired — the flag the payloads
  // still carry is DERIVED from the mode below for older servers).
  const [requirementMode, setRequirementMode] = React.useState("OPTIONAL");
  const [liveSessionId, setLiveSessionId] = React.useState("");
  const [eligibleSessions, setEligibleSessions] = React.useState<EligibleSession[]>([]);
  // The lesson home starts empty, so the session list mounts already
  // resolved (empty); the key block below re-arms loading per lesson.
  const [sessionsLoaded, setSessionsLoaded] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  // The lesson the video belongs to — REQUIRED (Phase A). Preselected when
  // the admin deep-linked here from the lesson's detail page.
  const [lessonId, setLessonId] = React.useState("");
  /** One-shot memory of the preselect, so a LATER manual batch switch
      (which clears the selection) never re-applies the deep link. */
  const preselectAppliedRef = React.useRef<string | null>(null);
  // Phase 23 UX — the SAME state machine the session-PDF screen uses, so a
  // video upload and a PDF upload show identical phases, identical REAL byte
  // progress and identical failure wording.
  const uploader = useMediaUpload();
  /** Remembered so a retry reports the same publish/draft outcome. */
  const lastPublishRef = React.useRef(false);
  const busy = saving || uploader.isBusy;
  /** The publish button names the phase it is in, not a generic "saving". */
  const uploadLabel = uploader.isBusy ? tr("admin.423") : tr("admin.210");

  // Every lesson id the picker can currently offer for the ACTIVE batch.
  const eligibleLessonIds = React.useMemo(
    () => flattenEligibleLessonIds(lessonGroups),
    [lessonGroups]
  );
  // Switching the batch — or the academic level — clears the selection ONLY
  // when the picker can no longer offer it. An incompatible lesson/batch pair
  // never lingers, while a lesson that stays eligible (a SHARED lesson across
  // the Arabic and Language batches) keeps its selection. Runs before the
  // preselect effect below so a deep link can still land after the switch.
  //
  // Phase L manual-QA fix: `levelFilter` joined these deps for the same
  // reason as the batch — narrowing to «أولى ثانوي» while a Second Secondary
  // lesson was selected must not leave that hidden lesson (or its already
  // fetched sessions) staged for publishing.
  React.useEffect(() => {
    setLessonId((prev) => (prev && eligibleLessonIds.has(prev) ? prev : ""));
    // The eligibility check is evaluated at the moment the batch/level
    // changes; the memo already reflects the new scope at that point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch.id, levelFilter]);
  // Preselect — applied exactly once, and only where the lesson is actually
  // offered (the picker never shows, and the server would reject, an
  // ineligible pair). If the lesson is not eligible for the current batch,
  // the deep link waits: switching to a batch that fits lands it.
  React.useEffect(() => {
    if (!initialLessonId || preselectAppliedRef.current === initialLessonId) return;
    if (!eligibleLessonIds.has(initialLessonId)) return;
    preselectAppliedRef.current = initialLessonId;
    setLessonId(initialLessonId);
  }, [initialLessonId, eligibleLessonIds]);
  // Eligible absence-source sessions for the ABSENT_STUDENTS picker. The
  // selection clears whenever the lesson home changes (a session from
  // another lesson must never ride along); a failed fetch degrades to an
  // empty list, which disables the absent option with its explanation.
  // Lesson-home switch, adjusted during render: the picked session never
  // rides along to another lesson, and the fetch below only subscribes.
  const [sessionsLessonKey, setSessionsLessonKey] = React.useState(lessonId);
  if (sessionsLessonKey !== lessonId) {
    setSessionsLessonKey(lessonId);
    setLiveSessionId("");
    if (!lessonId) {
      setEligibleSessions([]);
      setSessionsLoaded(true);
    } else {
      setSessionsLoaded(false);
    }
  }
  React.useEffect(() => {
    if (!lessonId) return;
    let cancelled = false;
    fetch(
      `/api/admin/session-videos/eligible-sessions?batchId=${encodeURIComponent(batch.id)}&lessonId=${encodeURIComponent(lessonId)}`
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        setEligibleSessions(Array.isArray(d?.sessions) ? d.sessions : []);
        setSessionsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setEligibleSessions([]);
        setSessionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [lessonId, batch.id]);

  const reset = () => {
    setTitle("");
    setTitleAr("");
    setDescription("");
    setVideoUrl("");
    setFile(null);
    setLessonId("");
    setRequirementMode("OPTIONAL");
    setLiveSessionId("");
    setRequiredPercent("95");
  };

  /** One place turns an upload result into what the admin sees. */
  const handleUploadResult = (res: MediaUploadResult, publish: boolean) => {
    if (res.ok) {
      toast.success(tr(publish ? "admin.237" : "admin.238"));
      reset();
      onPublished();
      return;
    }
    if ("duplicate" in res) {
      toast.error(tr("admin.570"));
      return;
    }
    if ("cancelled" in res) {
      toast.info(tr("admin.569"));
      return;
    }
    // Stage-specific + code-specific wording, resolved once for every surface.
    toast.error(uploadFailureMessage(res.failure, tr));
  };

  /** Retry the SAME file after a failure — a fresh init/PUT/complete cycle. */
  const retryUpload = async () => {
    const res = await uploader.retry();
    if (res) handleUploadResult(res, lastPublishRef.current);
  };

  const submit = async (publish: boolean) => {
    // The hook's latch is the real single-flight guarantee (it is synchronous);
    // this only stops a second click from building a request at all.
    if (busy) return;
    if (!title.trim()) {
      toast.error(tr("admin.580"));
      return;
    }
    // Phase A — a video without a lesson is not a video: it has no academic
    // session to belong to. Told BEFORE any request, and re-enforced by the
    // server on every creation path.
    if (!lessonId) {
      toast.error(tr("admin.583"));
      return;
    }
    if (method === "URL" && !videoUrl.trim()) {
      toast.error(tr("api.219"));
      return;
    }
    if (method === "URL") {
      // Same contract the server enforces (src/lib/video-url.ts), checked here
      // so the admin is told the exact problem BEFORE a request is made —
      // rather than discovering later that students see an unplayable video.
      const external = normalizeExternalVideoUrl(videoUrl);
      if (!external.ok) {
        toast.error(
          tr(
            external.code === "MALFORMED"
              ? "api.217"
              : external.code === "INSECURE_PROTOCOL"
                ? "api.303"
                : external.code === "UNSAFE_HOST"
                  ? "api.304"
                  : "api.305"
          )
        );
        return;
      }
    }
    if (method === "UPLOAD" && !file) {
      toast.error(tr("api.219"));
      return;
    }
    // Progression requirement: the SERVER is authoritative (50–100, no
    // clamping — an out-of-range threshold is a 422, never a silent rewrite).
    // The client only fails fast on non-numeric input with the IDENTICAL
    // api.361 copy (no request, value preserved for correction); REQUIRED on
    // an external URL is unexpressible (no verified watch %) so the selector
    // forces OPTIONAL for that method (stated in the form).
    // The RAW string rides every creation path (presigned completeFields +
    // buffered fallback + URL JSON) so the server validates exactly what the
    // admin typed; a 422 surfaces its Arabic `error` with the value intact.
    const percentNum = Number(requiredPercent);
    if (!Number.isFinite(percentNum)) {
      toast.error(tr("api.361"));
      return;
    }
    const threshold = requiredPercent;
    // Trackability gates expression: non-OPTIONAL modes are unexpressible on
    // an external URL (no verified watch %), so the payload forces OPTIONAL
    // there — stated in the form, re-enforced by the server on write.
    const trackable = method === "UPLOAD";
    const modeValue = trackable ? requirementMode : "OPTIONAL";
    const sessionValue = modeValue === "ABSENT_STUDENTS" ? liveSessionId : "";
    // Dual-written legacy flag, derived from the mode (older readers keep
    // their exact meaning: non-OPTIONAL ⇔ required for the audience).
    const requiredForProgression = modeValue !== "OPTIONAL";
    lastPublishRef.current = publish;

    if (method === "UPLOAD") {
      const target = file!;
      const res = await uploader.run(
        {
          // Phase 23 — direct browser → private R2 upload (short-lived
          // presigned PUT): bytes never buffer through the app server. The
          // second argument is the MEDIA_BACKEND=local fallback, used when the
          // init endpoint answers PRESIGNED_UNSUPPORTED.
          purpose: "SESSION_VIDEO",
          file: target,
          initFields: { batchId: batch.id, lessonId },
          completeFields: {
            batchId: batch.id,
            lessonId,
            title,
            titleAr: titleAr || title,
            description,
            publish,
            isRequiredForProgression: requiredForProgression,
            requirementMode: modeValue,
            liveSessionId: sessionValue,
            requiredPercent: threshold,
          }, // raw string — the complete route validates, never coerces
          // No browser-side hash for videos: a 512 MB buffer just to hash it
          // is worse than skipping the optional integrity proof.
          sha256: null,
        },
        async (f) => {
          const form = new FormData();
          form.set("batchId", batch.id);
          form.set("lessonId", lessonId);
          form.set("title", title);
          form.set("titleAr", titleAr || title);
          form.set("description", description);
          form.set("publish", String(publish));
          form.set("isRequiredForProgression", String(requiredForProgression));
          form.set("requirementMode", modeValue);
          form.set("liveSessionId", sessionValue);
          form.set("requiredPercent", String(threshold));
          form.set("file", f);
          try {
            const r = await fetch("/api/admin/session-videos", {
              method: "POST",
              body: form,
            });
            const d = await r.json().catch(() => null);
            if (!r.ok) {
              return {
                ok: false,
                status: r.status,
                error:
                  (d && typeof d.error === "string" && d.error) || "admin.001",
              };
            }
            return { ok: true };
          } catch {
            return { ok: false, status: 0, error: "admin.001" };
          }
        }
      );
      handleUploadResult(res, publish);
      return;
    }

    // URL method: no bytes move through the browser, so there is nothing to
    // measure — one JSON POST, contract unchanged.
    setSaving(true);
    try {
      const res = await fetch("/api/admin/session-videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchId: batch.id,
          lessonId,
          title,
          titleAr: titleAr || title,
          description,
          videoUrl,
          publish,
          isRequiredForProgression: requiredForProgression,
          requirementMode: modeValue,
          liveSessionId: sessionValue,
          requiredPercent: threshold,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || tr("admin.001"));
      toast.success(tr(publish ? "admin.237" : "admin.238"));
      reset();
      onPublished();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4">
      <CardHeader className="p-0 pb-3">
        <CardTitle className="text-base">{tr("admin.204")}</CardTitle>
        <CardDescription className="text-xs">{tr("admin.205")}</CardDescription>
      </CardHeader>
      <CardContent className="p-0 space-y-3">
        {/* Academic ownership — REQUIRED for every new video (Phase A).
            The picker offers only lessons this batch can legally hold:
            the batch's course when it declares one (or any course for a
            school-type pool), never archived, track compatible. */}
        <div>
          {/* Phase L manual-QA fix — ACADEMIC LEVEL switch for the picker
              below. Both official curricula are live (First Secondary: 62
              lessons, Second Secondary: 23), so the one lesson list would
              otherwise mix two levels whose lessons share officialCodes.
              One click, always visible, filtering on the canonical
              Course.academicLevel — a different axis from the Arabic /
              Language batches above, which are untouched. */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <GraduationCap className="w-3.5 h-3.5" />
              {tr("admin.642")}
            </span>
            <AcademicLevelSegmentedFilter value={levelFilter} onChange={onLevelFilterChange} />
          </div>
          <Label htmlFor="sv-lesson" className="inline-flex items-center gap-1.5">
            <BookOpen className="w-3.5 h-3.5" />
            {tr("admin.586")}
          </Label>
          {/* Themed Select (never native): a native option popup ignores
              the dark theme; option groups render as SelectGroup. Kept
              OUTSIDE the parenthesized branches below: a leading JSX
              comment there parses as an object literal and breaks it. */}
          {lessonsLoading ? (
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {tr("admin.588")}
            </div>
          ) : lessonsError ? (
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-destructive">
              <span>{tr("admin.590")}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2"
                onClick={onRetryLessons}
              >
                {tr("notif.retry")}
              </Button>
            </div>
          ) : lessonGroups.length === 0 ? (
            <div className="mt-1 text-xs text-muted-foreground">{tr("admin.589")}</div>
          ) : (
            <Select
              value={lessonId || SV_NO_LESSON}
              onValueChange={(v) => setLessonId(v === SV_NO_LESSON ? "" : v)}
              disabled={busy}
            >
              <SelectTrigger id="sv-lesson" className="w-full min-w-0">
                <SelectValue placeholder={tr("admin.587")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SV_NO_LESSON}>{tr("admin.587")}</SelectItem>
                {lessonGroups.map((g) => (
                  <SelectGroup key={g.key}>
                    <SelectLabel>{g.label}</SelectLabel>
                    {g.lessons.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {lessonOptionLabel(l, tr)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">{tr("admin.583")}</p>
        </div>

        {/* Method switch — both upload and URL are clearly supported. */}
        <div className="flex flex-wrap gap-2">
          {(
            [
              { value: "URL", labelKey: "admin.209", Icon: Link2 },
              { value: "UPLOAD", labelKey: "admin.208", Icon: Upload },
            ] as const
          ).map(({ value, labelKey, Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={method === value}
              disabled={busy}
              onClick={() => setMethod(value)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                method === value
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/50 text-muted-foreground hover:bg-muted"
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {tr(labelKey)}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="sv-title">{tr("admin.235")} (EN)</Label>
            <Input
              id="sv-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="sv-title-ar">{tr("admin.235")} (AR)</Label>
            <Input
              id="sv-title-ar"
              value={titleAr}
              onChange={(e) => setTitleAr(e.target.value)}
              disabled={busy}
              className="mt-1"
            />
          </div>
        </div>

        {method === "URL" ? (
          // Each method renders its OWN subtree. The wrapper divs carry stable
          // keys so that switching URL <-> UPLOAD unmounts/mounts a fresh input
          // instead of React reusing the SAME <input> element and morphing it
          // between a controlled (value=) text input and an uncontrolled file
          // input — which otherwise fires the "controlled input is becoming
          // uncontrolled / vice-versa" console warnings.
          <div key="sv-url-field">
            <Label htmlFor="sv-url">{tr("admin.209")}</Label>
            <Input
              id="sv-url"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://..."
              dir="ltr"
              disabled={busy}
              className="mt-1"
            />
            {/* State the contract in the form, so an admin does not have to
                discover it through a rejection. */}
            <p className="mt-1 text-[11px] text-muted-foreground" dir="rtl">
              {tr("admin.538")}
            </p>
          </div>
        ) : (
          <div key="sv-file-field">
            <Label htmlFor="sv-file">{tr("admin.208")}</Label>
            <Input
              id="sv-file"
              type="file"
              accept="video/mp4,video/webm,video/ogg,video/quicktime"
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                // A new pick clears any previous failure so the admin is never
                // stuck with a stale panel (and can always retry with a
                // different file).
                uploader.reset();
              }}
              className="mt-1"
            />
            {/* State the accepted formats + ceiling in the form, so an admin
                does not have to discover them through a rejection. */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {tr("admin.582")}
            </p>
          </div>
        )}

        <div>
          <Label htmlFor="sv-desc">{tr("admin.249")}</Label>
          <Textarea
            id="sv-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            disabled={busy}
            className="mt-1"
          />
        </div>

        {/* Progression requirement — explicit OPTIONAL / ALL_STUDENTS /
            ABSENT_STUDENTS per video. The threshold keeps the existing
            50–100 range rule (default 95). Non-OPTIONAL modes on an external
            URL are unexpressible (no verified watch %), so the options are
            disabled for that method — stated in the form, re-enforced by
            the server on every creation path. */}
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <RequirementModeSelector
            idPrefix="sv"
            mode={requirementMode}
            onModeChange={setRequirementMode}
            liveSessionId={liveSessionId}
            onSessionChange={setLiveSessionId}
            trackable={method === "UPLOAD"}
            lessonId={lessonId}
            sessions={eligibleSessions}
            sessionsLoaded={sessionsLoaded}
            currentSession={null}
            disabled={busy}
            tr={tr}
          />
          <div>
            <Label htmlFor="sv-percent">{tr("admin.626")}</Label>
            <Input
              id="sv-percent"
              type="number"
              min={50}
              max={100}
              value={requiredPercent}
              onChange={(e) => setRequiredPercent(e.target.value)}
              inputMode="numeric"
              dir="ltr"
              disabled={busy}
              className="mt-1 w-24"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">{tr("admin.627")}</p>
          </div>
        </div>

        {/* Real upload state — the same panel the session-PDF screen renders:
            preparing → uploading (MB / MB — %) → confirming → success/failure.
            "Completed" is only ever shown AFTER the server confirmed the save. */}
        <UploadProgressPanel
          state={uploader.state}
          onCancel={uploader.cancel}
          onRetry={retryUpload}
        />

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={() => submit(true)} disabled={busy}>
            {busy ? (
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4 me-2" />
            )}
            {uploadLabel}
          </Button>
          <Button variant="outline" onClick={() => submit(false)} disabled={busy}>
            {tr("admin.212")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** A LiveSession the ABSENT_STUDENTS picker may offer (see
    GET /api/admin/session-videos/eligible-sessions). */

/**
 * Sentinel item values: Radix Select items need non-empty values, while the
 * lesson/session pickers legitimately clear to "" — the sentinels
 * round-trip through onValueChange so the state shape never changes.
 */
const SV_NO_LESSON = "__no_lesson__";
const SV_NO_SESSION = "__no_session__";
type EligibleSession = {
  id: string;
  title: string;
  titleAr: string;
  startAt: string;
  status: string;
  groupName: string | null;
  /** Group → Course → Level context (read-only, from the server). */
  courseName?: string | null;
  academicLevel?: string | null;
  finalized: boolean;
};

/** Progression-requirement mode selector, shared by the publish and edit
    forms. Three explicit options (admin.635–637, exact platform copy):
    OPTIONAL (extra content), ALL_STUDENTS (everyone), ABSENT_STUDENTS (only
    students with an unexcused absence for the linked session). Non-OPTIONAL
    modes are unexpressible for untrackable (URL) media; ABSENT_STUDENTS
    additionally needs a lesson home plus at least one eligible session —
    otherwise the option is disabled WITH the reason stated, never offered
    dead. The server re-enforces every rule on write. All styling uses theme
    tokens (light/dark safe by construction). */
function RequirementModeSelector({
  idPrefix,
  mode,
  onModeChange,
  liveSessionId,
  onSessionChange,
  trackable,
  lessonId,
  sessions,
  sessionsLoaded,
  currentSession,
  disabled,
  tr,
}: {
  idPrefix: string;
  mode: string;
  onModeChange: (mode: string) => void;
  liveSessionId: string;
  onSessionChange: (id: string) => void;
  trackable: boolean;
  lessonId: string;
  sessions: EligibleSession[];
  sessionsLoaded: boolean;
  currentSession: { id: string; title: string; titleAr: string } | null;
  disabled: boolean;
  tr: (key: string) => string;
}) {
  const absentBlockedReason = !trackable
    ? tr("admin.628")
    : !lessonId
      ? tr("admin.640")
      : sessionsLoaded && sessions.length === 0
        ? tr("admin.641")
        : null;
  const absentEnabled = trackable && !!lessonId && sessionsLoaded && sessions.length > 0;
  // A previously-linked session that no longer qualifies (e.g. cancelled
  // after linking) is SHOWN as the broken current value — disabled, so the
  // admin sees what must be replaced instead of a silently blank picker.
  const showCurrentSession =
    currentSession && !sessions.some((s) => s.id === currentSession.id)
      ? currentSession
      : null;
  return (
    <div className="space-y-2">
      <span className="text-sm font-medium text-foreground">{tr("admin.634")}</span>
      <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={tr("admin.634")}>
        {(
          [
            { value: "OPTIONAL", label: tr("admin.635"), enabled: true },
            { value: "ALL_STUDENTS", label: tr("admin.636"), enabled: trackable },
            { value: "ABSENT_STUDENTS", label: tr("admin.637"), enabled: absentEnabled },
          ] as const
        ).map((opt) => (
          <label
            key={opt.value}
            htmlFor={`${idPrefix}-mode-${opt.value}`}
            className={`flex items-center gap-2 text-sm ${
              opt.enabled && !disabled ? "text-foreground" : "text-muted-foreground"
            }`}
          >
            <input
              id={`${idPrefix}-mode-${opt.value}`}
              type="radio"
              name={`${idPrefix}-mode`}
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => onModeChange(opt.value)}
              disabled={disabled || !opt.enabled}
              className="h-4 w-4 shrink-0"
            />
            {opt.label}
          </label>
        ))}
      </div>
      {!trackable && (
        <p className="text-[11px] text-muted-foreground">{tr("admin.628")}</p>
      )}
      {trackable && absentBlockedReason && (
        <p className="text-[11px] text-muted-foreground">{absentBlockedReason}</p>
      )}
      {mode === "ABSENT_STUDENTS" && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">{tr("admin.638")}</p>
          <Label htmlFor={`${idPrefix}-session`}>{tr("admin.639")}</Label>
          {/* Themed Select (never native): a native option popup ignores
              the dark theme. The placeholder rides a sentinel so clearing
              the session keeps working exactly as before. */}
          <Select
            value={liveSessionId || SV_NO_SESSION}
            onValueChange={(v) => onSessionChange(v === SV_NO_SESSION ? "" : v)}
            disabled={disabled || !absentEnabled}
          >
            <SelectTrigger id={`${idPrefix}-session`} className="w-full min-w-0">
              <SelectValue placeholder={tr("admin.639")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SV_NO_SESSION}>{tr("admin.639")}</SelectItem>
              {showCurrentSession && (
                <SelectItem value={showCurrentSession.id} disabled>
                  {showCurrentSession.titleAr || showCurrentSession.title}
                </SelectItem>
              )}
              {sessions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {(s.titleAr || s.title) +
                    (s.groupName ? ` — ${s.groupName}` : "") +
                    (s.courseName ? ` (${s.courseName} — ${academicLevelLabel(tr, s.academicLevel)})` : "") +
                    ` — ${new Date(s.startAt).toLocaleDateString()}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

/** Per-row edit form: metadata + the progression requirement. Non-OPTIONAL
    modes are disabled for URL-source rows (untrackable) with the same
    explainer the publish form states; the server re-enforces on PATCH. */
function EditVideoForm({
  video,
  onCancel,
  onSaved,
}: {
  video: SessionVideo;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const tr = useT();
  const [title, setTitle] = React.useState(video.title);
  const [titleAr, setTitleAr] = React.useState(video.titleAr);
  const [description, setDescription] = React.useState(video.description ?? "");
  const [percent, setPercent] = React.useState(String(video.requiredPercent));
  // The stored requirement, edited explicitly (legacy rows fall back to the
  // flag's exact historical meaning). The lesson home is fixed in the edit
  // form — the eligible sessions load once for (batch × lesson).
  const [requirementMode, setRequirementMode] = React.useState<string>(
    video.requirementMode ?? (video.isRequiredForProgression ? "ALL_STUDENTS" : "OPTIONAL")
  );
  const [liveSessionId, setLiveSessionId] = React.useState(video.liveSessionId ?? "");
  const editLessonIdForState = video.lesson?.id ?? "";
  const [eligibleSessions, setEligibleSessions] = React.useState<EligibleSession[]>([]);
  // A video without a lesson home mounts already resolved (empty list).
  const [sessionsLoaded, setSessionsLoaded] = React.useState(!editLessonIdForState);
  const [saving, setSaving] = React.useState(false);
  // Trackability is the row's storage, reached here as the list's `source`
  // (URL = EXTERNAL_URL = untrackable, UPLOAD = managed = measurable).
  const trackable = video.source !== "URL";
  const editLessonId = video.lesson?.id ?? "";
  // Lesson-home switch, adjusted during render: without a home the list is
  // empty and resolved; with one the fetch below only subscribes.
  const [editSessionsKey, setEditSessionsKey] = React.useState(editLessonId);
  if (editSessionsKey !== editLessonId) {
    setEditSessionsKey(editLessonId);
    if (!editLessonId) {
      setEligibleSessions([]);
      setSessionsLoaded(true);
    }
  }
  React.useEffect(() => {
    if (!editLessonId) return;
    let cancelled = false;
    fetch(
      `/api/admin/session-videos/eligible-sessions?batchId=${encodeURIComponent(video.batch.id)}&lessonId=${encodeURIComponent(editLessonId)}`
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return;
        setEligibleSessions(Array.isArray(d?.sessions) ? d.sessions : []);
        setSessionsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setEligibleSessions([]);
        setSessionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [editLessonId]);

  const save = async () => {
    if (!title.trim()) {
      toast.error(tr("admin.580"));
      return;
    }
    // Server-authoritative threshold (no clamping): fail fast on
    // non-numeric input with the identical api.361 copy, otherwise PATCH the
    // RAW value — a 422 toasts its Arabic `error` and every field keeps its
    // entered value for correction (nothing resets on failure).
    const n = Number(percent);
    if (!Number.isFinite(n)) {
      toast.error(tr("api.361"));
      return;
    }
    const threshold = percent;
    const modeValue = trackable ? requirementMode : "OPTIONAL";
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/session-videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          titleAr: titleAr.trim() || title.trim(),
          description,
          requiredPercent: threshold,
          requirementMode: modeValue,
          isRequiredForProgression: modeValue !== "OPTIONAL",
          liveSessionId: modeValue === "ABSENT_STUDENTS" ? liveSessionId : null,
        }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) throw new Error((d && d.error) || tr("admin.001"));
      toast.success(tr("admin.633"));
      onSaved();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/[0.03] p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`edit-title-${video.id}`}>{tr("admin.235")} (EN)</Label>
          <Input
            id={`edit-title-${video.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={saving}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor={`edit-title-ar-${video.id}`}>{tr("admin.235")} (AR)</Label>
          <Input
            id={`edit-title-ar-${video.id}`}
            value={titleAr}
            onChange={(e) => setTitleAr(e.target.value)}
            disabled={saving}
            className="mt-1"
          />
        </div>
      </div>
      <div>
        <Label htmlFor={`edit-desc-${video.id}`}>{tr("admin.249")}</Label>
        <Textarea
          id={`edit-desc-${video.id}`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          disabled={saving}
          className="mt-1"
        />
      </div>
      <div className="space-y-2 rounded-lg border border-border/60 p-3">
        <RequirementModeSelector
          idPrefix={`edit-${video.id}`}
          mode={requirementMode}
          onModeChange={setRequirementMode}
          liveSessionId={liveSessionId}
          onSessionChange={setLiveSessionId}
          trackable={trackable}
          lessonId={editLessonId}
          sessions={eligibleSessions}
          sessionsLoaded={sessionsLoaded}
          currentSession={video.liveSession}
          disabled={saving}
          tr={tr}
        />
        <div>
          <Label htmlFor={`edit-percent-${video.id}`}>{tr("admin.626")}</Label>
          <Input
            id={`edit-percent-${video.id}`}
            type="number"
            min={50}
            max={100}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            disabled={saving}
            className="mt-1 w-24"
          />
        </div>
      </div>
      <p className="-mt-1 text-[11px] text-muted-foreground">{tr("admin.627")}</p>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />}
          {tr("admin.630")}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
          {tr("admin.631")}
        </Button>
      </div>
    </div>
  );
}
