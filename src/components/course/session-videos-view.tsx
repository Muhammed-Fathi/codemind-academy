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
import { CheckCircle2, PlayCircle, Video, Lock } from "lucide-react";

type SessionVideo = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  lesson: { id: string; title: string; titleAr: string } | null;
  requiredPercent: number;
  publishedAt: string | null;
  src: string | null;
  isExternal: boolean;
  progress: { percent: number; isCompleted: boolean; watchedSec: number };
};

const HEARTBEAT_MS = 15_000;

export function StudentSessionVideosView() {
  const tr = useT();
  const [videos, setVideos] = React.useState<SessionVideo[]>([]);
  const [isEnrolled, setIsEnrolled] = React.useState(true);
  const [loading, setLoading] = React.useState(true);
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/students/me/session-videos");
      const d = await r.json();
      setIsEnrolled(d.isEnrolled !== false);
      setVideos(d.videos || []);
      setActiveId((prev) => prev || d.videos?.[0]?.id || null);
    } catch {
      setVideos([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

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
      <div>
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
              onProgress={(percent, isCompleted) =>
                setVideos((prev) =>
                  prev.map((v) =>
                    v.id === active.id
                      ? { ...v, progress: { ...v.progress, percent, isCompleted } }
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
                      {v.progress.isCompleted ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : (
                        <Video className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold">
                        {pickAuto(v.titleAr, v.title)}
                      </div>
                      <Progress value={v.progress.percent} className="mt-1 h-1" />
                    </div>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {v.progress.percent}%
                    </span>
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

function SessionVideoPlayer({
  video,
  onProgress,
}: {
  video: SessionVideo;
  onProgress: (percent: number, isCompleted: boolean) => void;
}) {
  const tr = useT();
  const ref = React.useRef<HTMLVideoElement | null>(null);
  const [percent, setPercent] = React.useState(video.progress.percent);
  const [completed, setCompleted] = React.useState(video.progress.isCompleted);
  const playingRef = React.useRef(false);

  const beat = React.useCallback(async () => {
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
        setCompleted(Boolean(d.isCompleted));
        onProgress(d.percent, Boolean(d.isCompleted));
      }
    } catch {
      /* transient network issues must not interrupt playback */
    }
  }, [video.id, onProgress]);

  // Heartbeat only while actually playing — a paused tab earns no credit.
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
        {video.src ? (
          <video
            ref={ref}
            src={video.src}
            controls
            controlsList="nodownload"
            onContextMenu={(e) => e.preventDefault()}
            playsInline
            preload="metadata"
            className="aspect-video w-full"
            onLoadedMetadata={handleLoaded}
            onPlay={() => {
              playingRef.current = true;
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
          <div className="grid aspect-video w-full place-items-center text-muted-foreground">
            <PlayCircle className="w-10 h-10" />
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
          </div>
          {completed ? (
            <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="w-3.5 h-3.5 me-1" />
              {tr("course.211")}
            </Badge>
          ) : (
            <Badge variant="outline">
              {tr("course.210")}: {percent}%
            </Badge>
          )}
        </div>
        <Progress value={percent} className="h-2" />
        <p className="text-[11px] text-muted-foreground">
          {tr("course.206")} ({video.requiredPercent}%)
        </p>
      </CardContent>
    </Card>
  );
}
