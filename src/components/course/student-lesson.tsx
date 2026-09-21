"use client";
import { useT, useLocale , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useApp } from "@/lib/store";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileText,
  Trophy,
  Video,
  BookOpen,
  PlayCircle,
  ClipboardList,
  GraduationCap,
  Bookmark,
  BookmarkCheck,
  StickyNote,
  Plus,
  Trash2,
  Loader2,
  Edit3,
  Lock,
  ListChecks,
  Circle,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
// Phase B — the ONE student video player (same heartbeat / resume /
// external-URL contract as the standalone library). Reused here so the
// Lesson workspace and the library can never diverge.
import { SessionVideoPlayer } from "@/components/course/session-videos-view";
import { SessionVideoBadges } from "@/components/course/session-videos-view";

// ============================================================
// Types
// ============================================================
type SessionVideoRequirementItem = {
  id: string;
  title: string;
  titleAr: string;
  requiredPercent: number;
  trackable: boolean;
  currentPercent: number;
  completed: boolean;
};

type SessionRequirement = {
  required: boolean;
  done: boolean;
  value: number;
  /** Video only: how many REQUIRED videos gate this lesson. */
  requiredCount?: number;
  /** Video only: how many of them currently satisfy their own threshold. */
  completedCount?: number;
  /** Video only: the per-video decomposition (REQUIRED videos only). */
  items?: SessionVideoRequirementItem[];
};

type SessionRequirements = {
  completed: boolean;
  unlocked: boolean;
  video: SessionRequirement;
  quiz: SessionRequirement;
  assignment: SessionRequirement;
  /**
   * Phase H — the canonical engine explanation. `state` is one of
   * LOCKED/UNLOCKED/COMPLETED, `reason` the Arabic sentence, `unmet` the
   * structured remainder. Rendered verbatim; never re-derived.
   */
  state?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  unmet?: { kind: string; label?: string | null }[] | null;
};

/** Phase H — structured denial details the server attaches to 403s. */
type DenialDetails = {
  state?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  unmet?: { kind: string; label?: string | null }[] | null;
  holdBlocked?: boolean;
} | null;

type LessonView = {
  lesson: {
    id: string;
    title: string;
    titleAr: string;
    /** Phase 16 — official session identity (1-1..7-3). */
    officialCode?: string | null;
    description: string | null;
    summary: string | null;
    duration: number;
    order: number;
    videoUrl: string | null;
    /** Phase 14: authorized material path or legacy external URL. Never a storageKey. */
    pdfUrl: string | null;
    /** Phase 14: safe material descriptors (id + downloadUrl only). */
    materials?: {
      id: string;
      title: string;
      kind: string;
      trackScope: string;
      downloadUrl: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      legacy: boolean;
    }[];
    // Phase 13: `isLocked` removed — the retired column is no longer sent, and
    // gating is decided by the server (`access.allowed`), never by the client.
  };
  part: { id: string; title: string; titleAr: string } | null;
  unit: { id: string; title: string; titleAr: string } | null;
  /** Legacy-only: canonical unit-linked lessons have no topic. */
  topic: { id: string; title: string; titleAr: string } | null;
  course: { id: string; slug: string; name: string; nameAr: string } | null;
  /** All quizzes of the session — the progression engine requires every one. */
  quizzes: {
    id: string;
    title: string;
    titleAr: string;
    description: string | null;
    passMark: number;
    questions: unknown[];
  }[];
  /** First quiz (backwards-compatible shorthand for `quizzes[0]`). */
  quiz: {
    id: string;
    title: string;
    titleAr: string;
    description: string | null;
    passMark: number;
    questions: unknown[];
  } | null;
  homework: {
    id: string;
    title: string;
    titleAr: string;
    instructions: string | null;
    deadline: string;
    maxMarks: number;
  } | null;
  progress: {
    progress: number;
    isCompleted: boolean;
    lastViewedAt: string | null;
  } | null;
  /** Phase 16 — server-computed unlock requirements (video/quiz/assignment). */
  requirements?: SessionRequirements | null;
  /** Phase C — the shared Lesson Content Summary (same authority as the tree). */
  content?: {
    video: { state: "ABSENT" | "AVAILABLE" | "LOCKED"; count: number };
    material: { state: "ABSENT" | "AVAILABLE" | "LOCKED"; count: number };
    quiz: { state: "ABSENT" | "AVAILABLE" | "LOCKED"; count: number };
    homework: { state: "ABSENT" | "AVAILABLE" | "LOCKED"; count: number };
  } | null;
  prevLessonId: string | null;
  nextLessonId: string | null;
};

// ============================================================
// Main
// ============================================================
export function StudentLessonView() {
  const t = useT();
  const locale = useLocale();
  const setView = useApp((s) => s.setView);
  const setNavParam = useApp((s) => s.setNavParam);
  const setLessonId = useApp((s) => s.setLessonId);
  const setQuizId = useApp((s) => s.setQuizId);
  const navParam = useApp((s) => s.navParam);
  const lessonId = useApp((s) => s.lessonId);
  const activeLessonId = lessonId;

  const [data, setData] = React.useState<LessonView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  // Phase 16 — the denial KIND is safe to surface (it reveals nothing about
  // the session itself) and it decides which skeleton the page renders: a
  // locked-session panel for gated sessions, a not-available panel for
  // unpublished/foreign ids. No content is fetched or shown in either case.
  const [errorKind, setErrorKind] = React.useState<
    "locked" | "held" | "missing" | "denied" | "error"
  >("error");
  // Phase H — the structured denial the server attached to the 403 (Arabic
  // reason + state + unmet). Rendered verbatim in the lock/hold panels.
  const [denial, setDenial] = React.useState<DenialDetails>(null);
  const [resolvingHold, setResolvingHold] = React.useState(false);
  const [completing, setCompleting] = React.useState(false);
  const [bookmarked, setBookmarked] = React.useState(false);

  const checkBookmark = React.useCallback(() => {
    if (!activeLessonId) return;
    fetch("/api/students/me/bookmarks")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const found = (d?.bookmarks || []).some((b: any) => b.lessonId === activeLessonId);
        setBookmarked(found);
      })
      .catch(() => {});
  }, [activeLessonId]);

  const toggleBookmark = async () => {
    if (!activeLessonId) return;
    if (bookmarked) {
      await fetch(`/api/students/me/bookmarks?lessonId=${encodeURIComponent(activeLessonId || "")}`, {
        method: "DELETE",
      });
      setBookmarked(false);
      toast.success(t("course.047"));
    } else {
      await fetch("/api/students/me/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: activeLessonId }),
      });
      setBookmarked(true);
      toast.success(t("course.048"));
    }
  };

  React.useEffect(() => {
    checkBookmark();
  }, [checkBookmark]);

  const reload = React.useCallback(() => {
    if (!activeLessonId) {
      setError(t("course.049"));
      setErrorKind("error");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setDenial(null);
    fetch(`/api/lessons/${encodeURIComponent(activeLessonId || "")}`)
      .then(async (r) => {
        if (r.ok) return r.json();
        const body = await r.json().catch(() => ({}));
        const b = body as { code?: string; details?: DenialDetails } | null;
        return Promise.reject({
          status: r.status,
          code: b?.code,
          details: b?.details ?? null,
        });
      })
      .then((d) => setData(d))
      .catch(
        (e: { status?: number; code?: string; details?: DenialDetails } | null) => {
          // Phase H — denials carry the canonical explanation (Arabic reason
          // + state + structured unmet). The panels below render it verbatim;
          // the legacy generic strings stay as fallbacks only. An absence
          // hold gets its own panel with a catch-up CTA.
          const details = e?.details ?? null;
          setDenial(details);
          if (e?.status === 403 && e?.code === "ABSENCE_HOLD") {
            setErrorKind("held");
            setError(details?.reason || t("course.204"));
          } else if (
            e?.status === 403 &&
            (e?.code === "PREVIOUS_SESSION_INCOMPLETE" ||
              e?.code === "REQUIREMENTS_UNMET")
          ) {
            setErrorKind("locked");
            setError(details?.reason || t("course.204"));
          } else if (e?.status === 403) {
            setErrorKind("denied");
            setError(details?.reason || t("course.212"));
          } else if (e?.status === 404) {
            setErrorKind("missing");
            setError(t("course.218"));
          } else {
            setErrorKind("error");
            setError(t("course.050"));
          }
        }
      )
      .finally(() => setLoading(false));
  }, [activeLessonId, t]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Phase H — resolve eligible absence holds, then re-attempt the fetch so a
  // lifted hold opens the session immediately.
  const resolveHold = async () => {
    setResolvingHold(true);
    try {
      const r = await fetch("/api/students/me/catchup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const j = (await r.json().catch(() => null)) as {
        resolved?: unknown[];
        error?: string;
      } | null;
      if (r.ok && j && (j.resolved?.length ?? 0) > 0) {
        toast.success(t("phaseh.catchupDone"));
      } else if (r.ok) {
        toast.warning(t("phaseh.catchupNoneNew"));
      } else {
        toast.error(j?.error || t("course.050"));
      }
    } catch {
      toast.error(t("course.050"));
    } finally {
      setResolvingHold(false);
      reload();
    }
  };

  if (loading) return <LessonSkeleton />;

  if (error || !data) {
    // Phase 16 — locked and missing sessions render distinct, content-free
    // skeletons. Neither panel names the session (its title is unknown here
    // by construction: the server refused the fetch), so a locked panel can
    // never become an oracle for unpublished content.
    // Phase H — an absence hold renders the same posture with its own title,
    // the server's Arabic reason + structured unmet, and a catch-up CTA.
    if (
      errorKind === "locked" ||
      errorKind === "held" ||
      errorKind === "missing"
    ) {
      const locked = errorKind === "locked";
      const held = errorKind === "held";
      return (
        <Card className="glass">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center px-6">
            <div
              className={`grid place-items-center w-14 h-14 rounded-full mb-4 ${
                locked
                  ? "bg-amber-400/15 text-amber-500"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {locked ? (
                <Lock className="w-7 h-7" />
              ) : (
                <BookOpen className="w-7 h-7" />
              )}
            </div>
            <p className="text-base font-bold mb-1">
              {held
                ? t("phaseh.heldTitle")
                : locked
                  ? t("course.203")
                  : t("course.217")}
            </p>
            <p className="text-sm text-muted-foreground max-w-md">
              {error || t("course.051")}
            </p>
            {/* Phase H — the structured remainder the server attached to the
                denial. Safe by construction (labels only, no content). */}
            {(errorKind === "locked" || held) &&
              denial?.unmet &&
              denial.unmet.length > 0 && (
                <div className="flex items-center justify-center gap-1.5 flex-wrap mt-3">
                  {denial.unmet.slice(0, 4).map((u, i) => (
                    <Badge
                      key={`${u.kind}-${i}`}
                      variant="outline"
                      className="bg-amber-400/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                    >
                      {u.label || u.kind}
                    </Badge>
                  ))}
                </div>
              )}
            <div className="flex flex-col sm:flex-row items-center gap-2 mt-5">
              {held && (
                <Button onClick={resolveHold} disabled={resolvingHold}>
                  {resolvingHold
                    ? t("phaseh.catchupWorking")
                    : t("phaseh.catchupCta")}
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => setView("student-dashboard")}
              >
                <ArrowRight className="w-4 h-4 ms-1.5 flip-rtl" />
                {t("course.225")}</Button>
              <Button variant="ghost" onClick={reload}>
                {t("course.036")}</Button>
            </div>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card className="glass">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-base font-semibold mb-1">
            {error || t("course.051")}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => setView("student-course")}
          >
            <ArrowRight className="w-4 h-4 ms-1.5 flip-rtl" />
            {t("course.052")}</Button>
        </CardContent>
      </Card>
    );
  }

  const progressPct = data.progress?.progress || 0;
  // Phase H — completion is the canonical engine verdict. The route already
  // converges `progress.isCompleted` onto it, but the requirements row is the
  // first-class source (it survives even when the progress row is absent).
  const isCompleted =
    data.requirements?.completed ?? data.progress?.isCompleted ?? false;

  // Phase H — "Mark as Complete" is a CLAIM, not a write. The server accepts
  // it only when the canonical engine already evaluates the session as
  // completed; a premature claim returns the Arabic reason, shown verbatim.
  // A success re-fetches so the checklist reflects the engine, never an
  // optimistic local flip.
  const markComplete = async () => {
    setCompleting(true);
    try {
      const res = await fetch(
        `/api/lessons/${encodeURIComponent(data.lesson.id)}/progress`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completed: true }),
        }
      );
      const body = (await res.json().catch(() => null)) as {
        completed?: boolean;
        reason?: string;
        error?: string;
        details?: DenialDetails;
      } | null;
      if (!res.ok) {
        toast.error(
          body?.details?.reason || body?.reason || body?.error || t("course.054")
        );
        return;
      }
      if (body?.completed) {
        toast.success(t("course.053"));
        reload();
      } else {
        toast.warning(body?.reason || t("course.054"));
      }
    } catch {
      toast.error(t("course.054"));
    } finally {
      setCompleting(false);
    }
  };

  // Manual-QA stabilization: prev/next MUST move the store's `lessonId` — the
  // fetch key (`activeLessonId`) — not just `navParam`, which nothing on
  // this view reads. (Pre-existing: identical on main; Phase H never touched
  // it.) Targets stay the server's canonical chain ids; a locked target
  // renders the server's denial panel — the client never pre-filters.
  const gotoLesson = (id: string) => {
    setLessonId(id);
    setView("student-lesson");
    setNavParam(id);
  };

  return (
    <div className="space-y-5">
      {/* Breadcrumb + Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="space-y-2"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            className="px-2 text-muted-foreground"
            onClick={() => {
              setView("student-course");
              if (data.course) setNavParam(data.course.slug);
            }}
          >
            <ArrowRight className="w-3.5 h-3.5 ms-1 flip-rtl" />
            {t("course.055")}</Button>
          {data.part && (
            <>
              <span>{pickAuto(data.part.titleAr, data.part.title)}</span>
              <span>›</span>
            </>
          )}
          {data.unit && (
            <>
              <span>{pickAuto(data.unit.titleAr, data.unit.title)}</span>
              <span>›</span>
            </>
          )}
          {data.topic ? (
            <span className="text-foreground">
              {pickAuto(data.topic.titleAr, data.topic.title)}
            </span>
          ) : (
            <span className="text-foreground">
              {pickAuto(data.lesson.titleAr, data.lesson.title)}
            </span>
          )}
        </div>
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold leading-tight">
              <span className="text-gradient">
                {pickAuto(data.lesson.titleAr, data.lesson.title)}
              </span>
            </h1>
            {data.lesson.description && (
              <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
                {data.lesson.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
            {data.lesson.officialCode && (
              <Badge
                variant="outline"
                className="bg-primary/10 text-primary border-primary/30 tabular-nums"
              >
                {data.lesson.officialCode}
              </Badge>
            )}
            <Badge variant="outline" className="bg-muted/50">
              <Clock className="w-3 h-3 ms-1" />
              {data.lesson.duration} {t("course.056")}</Badge>
            {isCompleted ? (
              <Badge
                variant="outline"
                className="border-primary/30 text-primary bg-primary/10"
              >
                <CheckCircle2 className="w-3.5 h-3.5 ms-1" />
                Completed
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber-400/30 text-amber-600 bg-amber-400/10"
              >
                <PlayCircle className="w-3.5 h-3.5 ms-1" />
                {t("course.057")}</Badge>
            )}
            <button
              onClick={toggleBookmark}
              className={`grid place-items-center w-7 h-7 rounded-md transition-all hover:scale-110 ${
                bookmarked
                  ? "bg-amber-400/20 text-amber-500"
                  : "bg-muted text-muted-foreground hover:bg-amber-400/10 hover:text-amber-500"
              }`}
              title={bookmarked ? t("course.047") : t("course.059")}
            >
              {bookmarked ? (
                <BookmarkCheck className="w-4 h-4" />
              ) : (
                <Bookmark className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[11px] text-muted-foreground font-medium shrink-0">
            {t("course.242")}
          </span>
          <Progress value={progressPct} className="flex-1" />
          <span className="text-xs text-muted-foreground font-medium">
            {progressPct}%
          </span>
        </div>
      </motion.div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: video + materials */}
        <div className="lg:col-span-2 space-y-4">
          {/* Phase B — the video IS the first content of the academic
              session: eligible SessionVideo player(s) + playlist, the legacy
              videoUrl fallback, or a proper empty state. One section, one
              player, one authorized source (see LessonVideoSection). */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
          >
            {/* key: remount per lesson so prev/next navigation never shows
                the previous session's player or playlist */}
            <LessonVideoSection
              key={data.lesson.id}
              lessonId={data.lesson.id}
              legacyVideoUrl={data.lesson.videoUrl}
              lessonTitle={pickAuto(data.lesson.titleAr, data.lesson.title)}
            />
          </motion.div>

          {/* Summary */}
          {data.lesson.summary && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
            >
              <Card className="glass">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <BookOpen className="w-5 h-5 text-primary" />
                    {t("course.062")}</CardTitle>
                </CardHeader>
                <CardContent className="prose prose-sm dark:prose-invert max-w-none leading-relaxed text-foreground/90">
                  <ReactMarkdown>{data.lesson.summary}</ReactMarkdown>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Materials — Phase C: the session's authorized files live in the
              academic flow (Videos → Materials → Quiz → Homework). The card
              always renders; an absent list shows the approved lightweight
              empty state, never a broken control. */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.12 }}
          >
            <Card className="glass">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="w-5 h-5 text-amber-500" />
                  {t("course.233")}
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("course.234")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(() => {
                  const materialRows =
                    data.lesson.materials && data.lesson.materials.length > 0
                      ? data.lesson.materials
                      : data.lesson.pdfUrl
                        ? [
                            {
                              id: "legacy",
                              title: t("course.063"),
                              kind: "LEGACY_URL",
                              trackScope: "SHARED",
                              downloadUrl: data.lesson.pdfUrl,
                              mimeType: "application/pdf",
                              sizeBytes: null,
                              legacy: true,
                            },
                          ]
                        : [];
                  if (materialRows.length === 0) {
                    return (
                      <div className="text-center py-3 text-sm text-muted-foreground">
                        <FileText className="w-5 h-5 mx-auto mb-1 opacity-40" />
                        {t("course.230")}
                      </div>
                    );
                  }
                  return materialRows.map((m) => {
                    const href = m.downloadUrl
                      ? m.legacy
                        ? m.downloadUrl
                        : `${m.downloadUrl}?download=1`
                      : null;
                    if (!href) return null;
                    return (
                      <div key={m.id} className="flex items-center gap-3">
                        <div className="grid place-items-center w-10 h-10 rounded-lg bg-amber-400/15 text-amber-500 shrink-0">
                          <FileText className="w-5 h-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold">
                            {m.title || t("course.063")}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t("course.064")}
                          </div>
                        </div>
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex"
                        >
                          <Button variant="outline">
                            <FileText className="w-4 h-4 ms-1.5" />
                            {t("course.065")}
                          </Button>
                        </a>
                      </div>
                    );
                  });
                })()}
              </CardContent>
            </Card>
          </motion.div>

          {/* Quiz — Phase C: in the academic flow after materials. Presence,
              empty and (defensively) locked states come from the SAME server
              content summary the course tree badges use. */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.14 }}
          >
            <Card className="glass card-hover">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
                    <Trophy className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">
                      {t("course.235")}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      {t("course.074")}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {data.content?.quiz.state === "LOCKED" ? (
                  <div className="text-center py-3 text-sm text-muted-foreground">
                    <Lock className="w-5 h-5 mx-auto mb-1 opacity-40" />
                    {t("course.239")}
                  </div>
                ) : data.quizzes.length > 0 ? (
                  <div className="space-y-4">
                    {/* One card per quiz: the Phase 4 engine requires EVERY
                        quiz of a session to be attempted before the session
                        completes, so each one must be reachable here. */}
                    {data.quizzes.map((q) => (
                      <div key={q.id} className="space-y-3">
                        <div>
                          <div className="text-sm font-semibold">
                            {pickAuto(q.titleAr, q.title)}
                          </div>
                          {q.description && (
                            <div className="text-xs text-muted-foreground mt-1">
                              {q.description}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className="bg-muted/50">
                            {q.questions.length} Questions
                          </Badge>
                          <Badge variant="outline" className="bg-muted/50">
                            Pass: {q.passMark}%
                          </Badge>
                        </div>
                        <Button
                          className="w-full"
                          onClick={() => {
                            setView("student-quiz");
                            // Preserve the owning Lesson while switching the active entity to Quiz.
                            if (activeLessonId) setLessonId(activeLessonId);
                            setQuizId(q.id);
                            setNavParam(q.id);
                          }}
                        >
                          <Trophy className="w-4 h-4 ms-1.5" />
                          {t("course.075")}
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-3 text-sm text-muted-foreground">
                    <Trophy className="w-5 h-5 mx-auto mb-1 opacity-40" />
                    {t("course.231")}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Homework — Phase C: last stop of the academic flow. */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.16 }}
          >
            <Card className="glass card-hover">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="grid place-items-center w-9 h-9 rounded-lg bg-amber-400/15 text-amber-500">
                    <ClipboardList className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">
                      {t("course.236")}
                    </CardTitle>
                    <CardDescription className="text-xs">
                      {t("course.077")}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {data.content?.homework.state === "LOCKED" ? (
                  <div className="text-center py-3 text-sm text-muted-foreground">
                    <Lock className="w-5 h-5 mx-auto mb-1 opacity-40" />
                    {t("course.239")}
                  </div>
                ) : data.homework ? (
                  <div className="space-y-3">
                    <div>
                      <div className="text-sm font-semibold">
                        {pickAuto(data.homework.titleAr, data.homework.title)}
                      </div>
                      {data.homework.instructions && (
                        <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          {data.homework.instructions}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className="bg-muted/50">
                        <Clock className="w-3 h-3 ms-1" />
                        {new Intl.DateTimeFormat(
                          locale === "en" ? "en-GB" : "ar-EG",
                          {
                            day: "numeric",
                            month: "short",
                          }
                        ).format(new Date(data.homework.deadline))}
                      </Badge>
                      <Badge variant="outline" className="bg-muted/50">
                        <GraduationCap className="w-3 h-3 ms-1" />
                        {data.homework.maxMarks} {t("course.078")}
                      </Badge>
                    </div>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => setView("student-homework")}
                    >
                      <ClipboardList className="w-4 h-4 ms-1.5" />
                      {t("course.079")}
                    </Button>
                  </div>
                ) : (
                  <div className="text-center py-3 text-sm text-muted-foreground">
                    <ClipboardList className="w-5 h-5 mx-auto mb-1 opacity-40" />
                    {t("course.232")}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Mark complete */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
          >
            <Card className="glass">
              <CardContent className="flex flex-col sm:flex-row items-start sm:items-center gap-3 py-4">
                <div className="grid place-items-center w-10 h-10 rounded-lg bg-primary/10 text-primary shrink-0">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">
                    {isCompleted
                      ? t("course.066")
                      : t("course.067")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {isCompleted
                      ? t("course.068")
                      : t("course.069")}
                  </div>
                </div>
                <Button
                  onClick={markComplete}
                  disabled={completing || isCompleted}
                  variant={isCompleted ? "secondary" : "default"}
                >
                  <CheckCircle2 className="w-4 h-4 ms-1.5" />
                  {isCompleted ? t("course.070") : "Mark as Complete"}
                </Button>
              </CardContent>
            </Card>
          </motion.div>

          {/* Phase 16 — completion requirements. Server-computed
              (`data.requirements` from the progression engine); the client
              only renders the checklist, it never derives unlock state. */}
          {data.requirements && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.17 }}
            >
              <Card className="glass">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ListChecks className="w-5 h-5 text-primary" />
                    {t("course.205")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <RequirementRow
                    label={t("course.206")}
                    req={data.requirements.video}
                    detail={videoRequirementDetail(data.requirements.video, t)}
                  />
                  <RequirementRow
                    label={t("course.207")}
                    req={data.requirements.quiz}
                  />
                  <RequirementRow
                    label={t("course.208")}
                    req={data.requirements.assignment}
                  />
                  {/* Phase H — the canonical next action, verbatim from the
                      engine row, plus the structured remainder as chips. */}
                  {!data.requirements.completed && (
                    <div className="pt-1 space-y-2">
                      <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                        {data.requirements.reason || t("course.223")}
                      </p>
                      {(data.requirements.unmet?.length ?? 0) > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {data.requirements.unmet!.slice(0, 4).map((u, i) => (
                            <Badge
                              key={`${u.kind}-${i}`}
                              variant="outline"
                              className="bg-amber-400/10 text-amber-600 dark:text-amber-400 border-amber-500/30 text-[10px]"
                            >
                              {u.label || u.kind}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Prev / Next */}
          <div className="flex items-center justify-between gap-2 pt-2">
            {data.prevLessonId ? (
              <Button
                variant="outline"
                onClick={() => gotoLesson(data.prevLessonId!)}
              >
                <ArrowRight className="w-4 h-4 ms-1.5 flip-rtl" />
                {t("course.071")}</Button>
            ) : (
              <span />
            )}
            {data.nextLessonId ? (
              <Button onClick={() => gotoLesson(data.nextLessonId!)}>
                {t("course.072")}<ArrowLeft className="w-4 h-4 ms-1.5 flip-rtl" />
              </Button>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                {t("course.073")}</Badge>
            )}
          </div>
        </div>

        {/* Sidebar — study companion */}
        <div className="space-y-4">
          {/* Quick tip */}
          <Card className="glass border-primary/20">
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary shrink-0">
                  <PlayCircle className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-semibold mb-0.5">{t("course.081")}</div>
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    {t("course.082")}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Notes */}
          <LessonNotesSection lessonId={activeLessonId} />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Phase 16 — Requirement checklist row + linked recordings
// ============================================================
/**
 * The VIDEO row's detail badge, from the canonical payload only (no local
 * derivation): required recordings present → «1 من 2 فيديو مكتمل» (counts);
 * legacy-only requirement → «72%» (the legacy percent); not required → no
 * detail (the NOT_REQUIRED badge shows instead).
 */
function videoRequirementDetail(
  req: SessionRequirement,
  t: (key: string, params?: Record<string, unknown>) => string
): string | undefined {
  if (!req.required) return undefined;
  if (req.requiredCount) {
    return t("course.246", { p1: req.completedCount ?? 0, p2: req.requiredCount });
  }
  return `${req.value}%`;
}

function RequirementRow({
  label,
  req,
  detail,
}: {
  label: string;
  req: SessionRequirement;
  detail?: string;
}) {
  const t = useT();
  // Manual-QA stabilization: the canonical trichotomy, branched on
  // `required` FIRST (the engine reports `done=true` for absent components,
  // which must never render a green check):
  //   NOT_REQUIRED       → neutral circle + "غير مطلوب"
  //   REQUIRED_INCOMPLETE → neutral circle (+ detail, e.g. video %)
  //   REQUIRED_COMPLETE   → green check (+ detail)
  const state = !req.required
    ? "absent"
    : req.done
      ? "done"
      : "pending";
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
      {state === "done" ? (
        <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
      ) : (
        <Circle className="w-4 h-4 text-muted-foreground/40 shrink-0" />
      )}
      <span className="flex-1 min-w-0 text-sm">{label}</span>
      {state === "absent" ? (
        <Badge
          variant="outline"
          className="text-[10px] text-muted-foreground shrink-0"
        >
          {t("course.224")}
        </Badge>
      ) : detail ? (
        <Badge variant="outline" className="text-[10px] tabular-nums shrink-0">
          {detail}
        </Badge>
      ) : null}
    </div>
  );
}

// ============================================================
// Phase B — the Lesson's unified video workspace
// ============================================================
//
// The Lesson page is the canonical academic destination, so the video lives
// HERE, not only in the standalone library:
//
//   * loads the student's ELIGIBLE SessionVideo rows for THIS lesson from
//     /api/students/me/session-videos?lessonId= — the SAME endpoint the
//     standalone library uses, narrowed server-side to the lesson and, since
//     Phase B, also gated server-side by the lesson's own authorization
//     (enrollment + course + lifecycle + track + progression unlock). There
//     is no second authorization path and no frontend-only filtering.
//   * one eligible video  → a single clean player, no playlist chrome;
//   * several eligible    → main player + compact ordered playlist (beside
//     the player on desktop, stacked underneath on mobile); selecting an
//     item swaps the main player; the first eligible video is the default;
//   * no eligible video, but a legacy `Lesson.videoUrl` exists → the legacy
//     player is retained as a compatibility FALLBACK (documented; the column
//     is neither deleted nor migrated in Phase B);
//   * nothing at all      → a proper empty state, never a broken player;
//   * loading and error   → explicit, localized states (retry included).
//
// Only human-readable information is rendered: titles, session codes,
// durations and watch progress. Raw ids never reach the UI.
type LessonVideoItem = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  lesson: {
    id: string;
    title: string;
    titleAr: string;
    officialCode: string | null;
  } | null;
  requiredPercent: number;
  publishedAt: string | null;
  src: string | null;
  isExternal: boolean;
  isRequiredForProgression: boolean;
  trackable: boolean;
  progress: { percent: number; isCompleted: boolean; watchedSec: number; satisfied: boolean };
};

function LessonVideoSection({
  lessonId,
  legacyVideoUrl,
  lessonTitle,
}: {
  lessonId: string;
  legacyVideoUrl: string | null;
  lessonTitle: string;
}) {
  const t = useT();
  // null = still loading; [] = loaded, none eligible; list = loaded.
  // The PARENT keys this component by lesson id, so a lesson change remounts
  // the section with fresh state (no stale player from the previous lesson).
  const [videos, setVideos] = React.useState<LessonVideoItem[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  // true while a (re)fetch is in flight — set from the retry click, cleared
  // by the fetch outcome; drives the loading state without synchronous
  // setState in the effect body.
  const [pending, setPending] = React.useState(false);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/students/me/session-videos?lessonId=${encodeURIComponent(lessonId)}`
    )
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status)))
      )
      .then((d) => {
        if (cancelled) return;
        const list = (d?.videos ?? []) as LessonVideoItem[];
        setVideos(list);
        setFailed(false);
        setPending(false);
        // The first eligible video is the default selection.
        setActiveId(list[0]?.id ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setVideos([]);
        setFailed(true);
        setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lessonId, attempt]);

  const loading = videos === null || pending;
  const active = videos?.find((v) => v.id === activeId) ?? null;

  return (
    <Card className="glass overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Video className="w-5 h-5 text-primary" />
          {t("course.214")}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("course.215")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          // Clear loading state — never a black "broken" frame.
          <Skeleton className="aspect-video w-full" />
        ) : failed ? (
          // Clear error state with a localized retry.
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Video className="w-8 h-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {t("course.229")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPending(true);
                setAttempt((a) => a + 1);
              }}
            >
              {t("course.036")}
            </Button>
          </div>
        ) : videos.length > 0 && active ? (
          // Eligible modern SessionVideo(s): one player, ordered playlist.
          // Desktop: player + playlist side by side. Mobile: player first,
          // playlist stacked underneath (the grid collapses to one column).
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <SessionVideoPlayer
              key={active.id}
              video={active}
              onProgress={(percent, isCompleted, satisfied) =>
                setVideos((prev) =>
                  prev?.map((v) =>
                    v.id === active.id
                      ? {
                          ...v,
                          progress: { ...v.progress, percent, isCompleted, satisfied },
                        }
                      : v
                  ) ?? prev
                )
              }
            />
            {videos.length > 1 && (
              <div className="rounded-lg border border-border/60 p-3 lg:self-start">
                <div className="pb-2 text-sm font-semibold">
                  {t("course.214")}
                </div>
                <div className="space-y-2">
                  {videos.map((v, idx) => {
                    const isActive = v.id === activeId;
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setActiveId(v.id)}
                        aria-current={isActive}
                        className={`flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-start transition-colors ${
                          isActive
                            ? "border-primary bg-primary/5"
                            : "border-border/60 hover:bg-muted/50"
                        }`}
                      >
                        <div className="grid place-items-center w-8 h-8 shrink-0 rounded-lg bg-primary/10 text-primary">
                          {(v.isRequiredForProgression ? v.progress.satisfied : v.progress.isCompleted) ? (
                            <CheckCircle2 className="w-4 h-4" />
                          ) : (
                            <PlayCircle className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-semibold">
                            {idx + 1}. {pickAuto(v.titleAr, v.title)}
                          </div>
                          {v.lesson && (
                            <div className="truncate text-[10px] text-muted-foreground">
                              {v.lesson.officialCode
                                ? `${v.lesson.officialCode} · `
                                : ""}
                              {pickAuto(v.lesson.titleAr, v.lesson.title)}
                            </div>
                          )}
                          <div className="mt-1">
                            <SessionVideoBadges video={v} />
                          </div>
                          {v.trackable && (
                            <Progress
                              value={v.progress.percent}
                              className="mt-1 h-1"
                            />
                          )}
                        </div>
                        {v.trackable && !v.isRequiredForProgression && (
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                            {v.progress.percent}%
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : legacyVideoUrl ? (
          // DOCUMENTED LEGACY FALLBACK — retained compatibility path:
          // pre-Phase-12 lessons whose only video is the read-only
          // Lesson.videoUrl column. Rendering is exactly the historical
          // behaviour (bare embed of the stored URL); modern lessons never
          // reach this branch because eligible SessionVideos are preferred.
          <div className="aspect-video bg-black/90 relative">
            <iframe
              src={legacyVideoUrl}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              className="absolute inset-0 w-full h-full"
              title={lessonTitle}
            />
          </div>
        ) : (
          // Proper empty state — no broken player, no invented content.
          <div className="aspect-video bg-black/90 relative">
            <div className="absolute inset-0 grid place-items-center text-center">
              <div>
                <div className="grid place-items-center w-16 h-16 rounded-full bg-white/10 mx-auto mb-3">
                  <Video className="w-8 h-8 text-white/80" />
                </div>
                <p className="text-white/80 text-sm">
                  {t("course.228")}
                </p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LessonSkeleton() {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-2 w-full" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Lesson Notes Section — sticky notes for the student
// ============================================================
function LessonNotesSection({ lessonId }: { lessonId: string | null }) {
  const t = useT();
  const locale = useLocale();
  const [notes, setNotes] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [adding, setAdding] = React.useState(false);
  const [newNote, setNewNote] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editContent, setEditContent] = React.useState("");

  const reload = React.useCallback(() => {
    if (!lessonId) return;
    setLoading(true);
    fetch(`/api/students/me/notes?lessonId=${encodeURIComponent(lessonId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setNotes(d?.notes || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [lessonId]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const addNote = async () => {
    if (!newNote.trim() || !lessonId) return;
    setSaving(true);
    try {
      const r = await fetch("/api/students/me/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId, content: newNote.trim() }),
      });
      if (!r.ok) {
        toast.error(t("course.083"));
        return;
      }
      setNewNote("");
      setAdding(false);
      toast.success(t("course.084"));
      reload();
    } finally {
      setSaving(false);
    }
  };

  const updateNote = async (noteId: string) => {
    if (!editContent.trim()) return;
    setSaving(true);
    try {
      const r = await fetch("/api/students/me/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteId, content: editContent.trim() }),
      });
      if (!r.ok) {
        toast.error(t("course.085"));
        return;
      }
      setEditingId(null);
      setEditContent("");
      toast.success(t("course.086"));
      reload();
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (noteId: string) => {
    await fetch(`/api/students/me/notes?noteId=${encodeURIComponent(noteId)}`, {
      method: "DELETE",
    });
    toast.success(t("course.087"));
    reload();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
    >
      <Card className="glass card-hover">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="grid place-items-center w-9 h-9 rounded-lg bg-amber-400/15 text-amber-500">
                <StickyNote className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-base">{t("course.088")}</CardTitle>
                <CardDescription className="text-xs">
                  {t("course.089")}</CardDescription>
              </div>
            </div>
            {!adding && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAdding(true)}
                className="h-8 px-2"
              >
                <Plus className="w-4 h-4" />
                {t("course.090")}</Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {loading ? (
            <Skeleton className="h-20" />
          ) : (
            <>
              {adding && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="space-y-2"
                >
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder={t("course.091")}
                    className="min-h-[80px] resize-none text-sm bg-amber-400/5 border-amber-400/30 focus-visible:ring-amber-400/40"
                    autoFocus
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={addNote}
                      disabled={!newNote.trim() || saving}
                      className="h-8"
                    >
                      {saving ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        t("course.092")
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAdding(false);
                        setNewNote("");
                      }}
                      className="h-8"
                    >
                      {t("course.093")}</Button>
                  </div>
                </motion.div>
              )}

              {notes.length === 0 && !adding ? (
                <div className="text-center py-4">
                  <StickyNote className="w-8 h-8 text-muted-foreground/40 mx-auto mb-1.5" />
                  <p className="text-xs text-muted-foreground">
                    {t("course.094")}</p>
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pe-1">
                  {notes.map((n) => (
                    <motion.div
                      key={n.id}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="group relative rounded-lg bg-amber-400/10 border border-amber-400/20 p-3 hover:border-amber-400/40 transition-colors"
                    >
                      {editingId === n.id ? (
                        <div className="space-y-2">
                          <Textarea
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            className="min-h-[60px] resize-none text-xs bg-background"
                            autoFocus
                          />
                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              onClick={() => updateNote(n.id)}
                              disabled={saving}
                              className="h-7 text-xs"
                            >
                              {saving ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                t("course.092")
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingId(null);
                                setEditContent("");
                              }}
                              className="h-7 text-xs"
                            >
                              {t("course.093")}</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-xs leading-relaxed whitespace-pre-wrap pe-6">
                            {n.content}
                          </p>
                          <div className="mt-1.5 text-[10px] text-muted-foreground">
                            {new Date(n.updatedAt).toLocaleDateString(
                              locale === "en" ? "en-GB" : "ar-EG",
                              {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              }
                            )}
                          </div>
                          <div className="absolute top-2 start-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => {
                                setEditingId(n.id);
                                setEditContent(n.content);
                              }}
                              className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              title={t("course.097")}
                            >
                              <Edit3 className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => deleteNote(n.id)}
                              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                              title={t("course.098")}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </>
                      )}
                    </motion.div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
