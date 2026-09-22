"use client";

// ============================================================
// CodeMind Academy — Student: recorded session videos
//
// Shows only the videos published to the student's OWN batch. The list comes
// from /api/students/me/session-videos, which resolves the batch server-side
// from the student's school type — the client cannot ask for another batch.
//
// Watch progress uses the same tamper-resistant heartbeat contract as lesson
// videos: we report the real playhead every 15s and only while the video is
// actually playing, and the server credits at most the wall-clock time that
// truly elapsed. Seeking to the end therefore cannot fake a completion.
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { useT, pickAuto } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";
// Isomorphic, dependency-free — safe in a client component. Deciding the
// render mode here (rather than trusting a server flag) also repairs rows
// stored before the URL contract existed.
import { resolveExternalVideoPlayback } from "@/lib/video-url";
import { CheckCircle2, PlayCircle, Video, Lock } from "lucide-react";

type SessionVideo = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  /** Phase B — the session this recording belongs to (null for legacy batch-only rows). */
  lesson: {
    id: string;
    title: string;
    titleAr: string;
    /** Phase B — human-readable session identity (1-1). Never a raw id. */
    officialCode: string | null;
  } | null;
  requiredPercent: number;
  publishedAt: string | null;
  src: string | null;
  isExternal: boolean;
  /** Explicit REQUIRED-vs-OPTIONAL (server; default false). */
  isRequiredForProgression: boolean;
  /** Requirement mode + THIS student's engine verdict (absent = legacy shape). */
  requirementMode?: string;
  applicable?: boolean;
  applicability?: string;
  /** Managed storage (measurable) vs external (no server watch %). */
  trackable: boolean;
  progress: { percent: number; isCompleted: boolean; watchedSec: number; satisfied: boolean };
};

/** The minimal video shape the requirement badges read (both list types satisfy it). */
export type VideoBadgeInput = {
  isRequiredForProgression: boolean;
  trackable: boolean;
  requiredPercent: number;
  progress: { percent: number };
  /** Requirement mode + THIS student's engine verdict (absent = legacy shape). */
  requirementMode?: string;
  applicable?: boolean;
  applicability?: string;
};

/**
 * Requirement identity badges for ONE video — the SINGLE definition. The
 * library rows, the lesson playlist rows and the player header all render
 * these, from server flags only (no client-side derivation):
 *   REQUIRED + trackable → «مطلوب لإكمال الدرس» + «72% / 95%»
 *     (+ «مطلوب منك لتعويض غيابك» when an ABSENT_STUDENTS video applies);
 *   ABSENT_STUDENTS exempt → the explicit exemption («غير مطلوب منك — …»),
 *     never a silent re-label as extra content;
 *   OPTIONAL + trackable → «فيديو إضافي»;
 *   untrackable          → «نسبة المشاهدة غير متاحة» (never a bar/percent).
 */
export function SessionVideoBadges({ video }: { video: VideoBadgeInput }) {
  const tr = useT();
  if (!video.trackable) {
    return (
      <span className="text-[10px] text-muted-foreground">{tr("course.243")}</span>
    );
  }
  // `applicable` is the engine's per-student verdict; rows that predate it
  // fall back to the legacy flag (identical meaning for ALL/OPTIONAL).
  const required = video.applicable ?? video.isRequiredForProgression;
  const absentMode = video.requirementMode === "ABSENT_STUDENTS";
  if (required) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className="border-primary/40 bg-primary/10 text-primary text-[10px]"
        >
          {tr("course.244")}
        </Badge>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {video.progress.percent}% / {video.requiredPercent}%
        </span>
        {absentMode && (
          <span className="text-[10px] text-muted-foreground">{tr("course.247")}</span>
        )}
      </span>
    );
  }
  if (absentMode) {
    // Exempt from an absent-mode recording: say WHY, in the student's own
    // words — never silently shown as extra content.
    const key =
      video.applicability === "EXEMPT_EXCUSED"
        ? "course.249"
        : video.applicability === "EXEMPT_PRESENT"
          ? "course.248"
          : "course.251";
    return (
      <span className="text-[10px] text-muted-foreground">{tr(key)}</span>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      {tr("course.245")}
    </Badge>
  );
}

const HEARTBEAT_MS = 15_000;

export function StudentSessionVideosView() {
  const tr = useT();
  // Phase 16 — deep-link landing: `video:<id>` arrives here as navParam. The
  // list itself is the authorized set, so activating a matching id cannot
  // bypass anything — a foreign id simply matches nothing and keeps the
  // default selection.
  const navParam = useApp((s) => s.navParam);
  const [videos, setVideos] = React.useState<SessionVideo[]>([]);
  const [isEnrolled, setIsEnrolled] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const topRef = React.useRef<HTMLDivElement | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/students/me/session-videos");
      const d = await r.json();
      const list = (d.videos || []) as SessionVideo[];
      setIsEnrolled(d.isEnrolled !== false);
      setVideos(list);
      // A deep-linked id that exists in the authorized list becomes the
      // active video. Unknown ids fall through to the default selection.
      setActiveId((prev) =>
        navParam && list.some((v) => v.id === navParam)
          ? navParam
          : prev || list[0]?.id || null
      );
    } catch {
      setVideos([]);
    } finally {
      setLoading(false);
    }
  }, [navParam]);

  React.useEffect(() => {
    load();
  }, [load]);

  // Scroll the player into view after a deep-link landing. Scroll only — no
  // state is set here.
  React.useEffect(() => {
    if (!navParam || videos.length === 0) return;
    if (videos.some((v) => v.id === navParam)) {
      topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [navParam, videos]);

  const active = videos.find((v) => v.id === activeId) || null;

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  if (!isEnrolled) {
    return (
      <Card className="p-10">
        <div className="flex flex-col items-center gap-2 text-center">
          <Lock className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm font-semibold">{tr("course.200")}</p>
          <p className="text-xs text-muted-foreground">{tr("course.201")}</p>
        </div>
      </Card>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <div ref={topRef} className="scroll-mt-4">
        <h1 className="text-2xl font-bold text-gradient">{tr("admin.204")}</h1>
        <p className="text-xs text-muted-foreground">{tr("course.210")}</p>
      </div>

      {videos.length === 0 ? (
        <Card className="p-10">
          <p className="text-center text-sm text-muted-foreground">
            {tr("admin.234")}
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {active && (
            <SessionVideoPlayer
              key={active.id}
              video={active}
              onProgress={(percent, isCompleted, satisfied) =>
                setVideos((prev) =>
                  prev.map((v) =>
                    v.id === active.id
                      ? { ...v, progress: { ...v.progress, percent, isCompleted, satisfied } }
                      : v
                  )
                )
              }
            />
          )}

          <Card className="p-3">
            <CardHeader className="p-0 pb-2">
              <CardTitle className="text-sm">{tr("admin.204")}</CardTitle>
            </CardHeader>
            <CardContent className="p-0 space-y-2">
              {videos.map((v) => {
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
                      {((v.applicable ?? v.isRequiredForProgression) ? v.progress.satisfied : v.progress.isCompleted) ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <Video className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold">
                        {pickAuto(v.titleAr, v.title)}
                      </div>
                      {/* Phase B — every recording names its session, so the
                          library and the Lesson page never contradict. */}
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
                        <Progress value={v.progress.percent} className="mt-1 h-1" />
                      )}
                    </div>
                    {v.trackable && !(v.applicable ?? v.isRequiredForProgression) && (
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {v.progress.percent}%
                      </span>
                    )}
                  </button>
                );
              })}
            </CardContent>
          </Card>
        </div>
      )}
    </motion.div>
  );
}

// Exported (Phase B): the Lesson page renders its canonical video section
// with this SAME player, so there is exactly one student video player —
// same heartbeat contract, same resume, same external-URL contract — in the
// lesson workspace and in the standalone library.
export function SessionVideoPlayer({
  video,
  onProgress,
}: {
  video: SessionVideo;
  onProgress: (percent: number, isCompleted: boolean, satisfied: boolean) => void;
}) {
  const tr = useT();
  const ref = React.useRef<HTMLVideoElement | null>(null);
  const [percent, setPercent] = React.useState(video.progress.percent);
  // Whether THIS student must satisfy this recording (the engine verdict;
  // legacy rows fall back to the flag). REQUIRED videos complete by the
  // LIVE rule (satisfied), non-required by sticky history — the same rule
  // the rows apply, so player and rows agree.
  const requiredForStudent = video.applicable ?? video.isRequiredForProgression;
  const [completed, setCompleted] = React.useState(
    requiredForStudent ? video.progress.satisfied : video.progress.isCompleted
  );
  const playingRef = React.useRef(false);

  // Decide HOW to render before rendering anything.
  //   * Uploaded / managed media → `/api/media/<id>`, always a <video>.
  //   * External URL → the contract in src/lib/video-url.ts decides between a
  //     direct media file (<video>) and a YouTube/Vimeo embed (<iframe>).
  // `null` means "no media, or a URL outside the contract" and is rendered as
  // an explicit message rather than a player that silently never starts.
  const playback = React.useMemo(() => {
    if (!video.src) return null;
    if (!video.isExternal) return { mode: "video" as const, src: video.src };
    return resolveExternalVideoPlayback(video.src);
  }, [video.src, video.isExternal]);
  const beat = React.useCallback(async () => {
    // Untrackable (external) media accrues nothing server-side, so no beat is
    // even sent — the player stays a pure player for those rows.
    if (!video.trackable) return;
    const el = ref.current;
    if (!el || !el.duration || Number.isNaN(el.duration)) return;
    try {
      const r = await fetch(`/api/students/me/session-videos/${video.id}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positionSec: Math.floor(el.currentTime),
          durationSec: Math.floor(el.duration),
        }),
        keepalive: true,
      });
      const d = await r.json().catch(() => ({}));
      if (typeof d.percent === "number") {
        setPercent(d.percent);
        const done = requiredForStudent
          ? Boolean(d.satisfied)
          : Boolean(d.isCompleted);
        setCompleted(done);
        onProgress(d.percent, Boolean(d.isCompleted), Boolean(d.satisfied));
      }
    } catch {
      /* transient network issues must not interrupt playback */
    }
  }, [video.id, requiredForStudent, onProgress]);

  // Heartbeat design (server-verified, tamper-resistant):
  //   * a beat on PLAY anchors the server clock (the row's lastHeartbeatAt),
  //     so the elapsed-time credit of every LATER beat has a start point —
  //     without this anchor the first watch of short content accrues 0;
  //   * interval beats accrue while actually playing (a paused tab earns no
  //     credit);
  //   * pause / ended / unmount beats flush the tail, so the final segment
  //     is never lost.
  // Amounts stay server-measured (elapsed wall-clock between beats, capped,
  // position-bounded) — the client only decides WHEN to report, never how
  // much it earned.
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (playingRef.current) beat();
    }, HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      // Flush the final position on unmount so nothing is lost.
      if (playingRef.current) beat();
    };
  }, [beat]);

  // Resume where the student left off.
  const handleLoaded = () => {
    const el = ref.current;
    if (!el) return;
    const resume = video.progress.watchedSec;
    if (resume > 5 && resume < el.duration - 5) el.currentTime = resume;
  };

  return (
    <Card className="overflow-hidden">
      <div className="bg-black">
        {playback?.mode === "iframe" ? (
          // YouTube / Vimeo: the ONLY form these providers allow inside a page
          // is their embed player. A <video> element pointed at a watch URL can
          // never play — that was the production bug this branch replaces.
          <iframe
            src={playback.src}
            title={pickAuto(video.titleAr, video.title)}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            className="aspect-video w-full border-0"
          />
        ) : playback?.mode === "video" ? (
          <video
            ref={ref}
            src={playback.src}
            controls
            controlsList="nodownload"
            onContextMenu={(e) => e.preventDefault()}
            playsInline
            preload="metadata"
            className="aspect-video w-full"
            onLoadedMetadata={handleLoaded}
            onPlay={() => {
              playingRef.current = true;
              // Anchor the server clock at playback start (see above).
              beat();
            }}
            onPause={() => {
              playingRef.current = false;
              beat();
            }}
            onEnded={() => {
              playingRef.current = false;
              beat();
            }}
          />
        ) : (
          // Either no media is attached, or the stored URL is outside the
          // supported contract (a row created before validation existed).
          // Say so plainly instead of rendering a player that stays black.
          <div className="grid aspect-video w-full place-items-center gap-2 px-6 text-center text-muted-foreground">
            <PlayCircle className="w-10 h-10" />
            <p className="text-xs">{tr("course.226")}</p>
          </div>
        )}
      </div>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base font-bold">{pickAuto(video.titleAr, video.title)}</h2>
            {video.description && (
              <p className="mt-0.5 text-xs text-muted-foreground">{video.description}</p>
            )}
            <div className="mt-1.5">
              <SessionVideoBadges video={video} />
            </div>
          </div>
          {completed ? (
            <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5 me-1" />
              {tr("course.211")}
            </Badge>
          ) : video.trackable ? (
            <Badge variant="outline">
              {tr("course.210")}: {percent}%
            </Badge>
          ) : null}
        </div>
        {video.trackable ? (
          <>
            <Progress value={percent} className="h-2" />
            <p className="text-[11px] text-muted-foreground">
              {tr("course.206")} ({video.requiredPercent}%)
            </p>
          </>
        ) : playback?.mode === "iframe" ? (
          // An embedded player cannot report a playhead, so watch-time credit
          // is not tracked for it. State that explicitly rather than showing a
          // bar stuck at 0%. (Not shown when there is no playable media at
          // all — that case already explains itself above.)
          <p className="text-[11px] text-muted-foreground">{tr("course.227")}</p>
        ) : playback?.mode === "video" ? (
          // External direct file: playable, but no server watch % accrues.
          <p className="text-[11px] text-muted-foreground">{tr("course.243")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
