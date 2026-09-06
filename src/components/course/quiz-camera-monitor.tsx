"use client";

// ============================================================
// CodeMind Academy — Quiz camera monitor
//
// PRIVACY MODEL (deliberate, and surfaced to the student before any capture):
//   * The camera is NEVER started without an explicit click by the student on
//     the consent screen. Declining is a first-class option — the quiz still
//     runs, and the attempt is simply marked as "no camera".
//   * We take periodic STILL SNAPSHOTS only. There is no continuous recording,
//     no audio, and no live streaming of the student anywhere.
//   * Snapshots are uploaded to a private store, capped per attempt, and
//     auto-expire (QUIZ_EVIDENCE_RETENTION_DAYS, 30 by default).
//   * Only admins can view them; parents and teachers cannot.
//   * A visible "camera is active" indicator stays on screen the whole time.
//
// The component owns the MediaStream lifecycle and guarantees the tracks are
// stopped when the quiz ends or the component unmounts.
// ============================================================

import * as React from "react";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Camera, CameraOff, ShieldCheck, Loader2 } from "lucide-react";

export type CameraStatus =
  | "NOT_REQUESTED"
  | "GRANTED"
  | "DENIED"
  | "UNAVAILABLE"
  | "INTERRUPTED"
  | "DECLINED";

const SNAPSHOT_INTERVAL_MS = 90_000; // one still every 90s
const SNAPSHOT_WIDTH = 320; // small, low-bandwidth still

/** Consent gate shown before the quiz starts. */
export function QuizCameraConsent({
  onDecision,
  starting,
}: {
  onDecision: (allow: boolean) => void;
  starting: boolean;
}) {
  const tr = useT();
  return (
    <Card className="mx-auto max-w-lg p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="grid place-items-center w-10 h-10 shrink-0 rounded-xl bg-primary/10 text-primary">
          <ShieldCheck className="w-5 h-5" />
        </div>
        <div className="min-w-0 space-y-1">
          <h3 className="text-base font-bold">{tr("quiz.200")}</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {tr("quiz.201")}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {tr("quiz.202")}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="flex-1" onClick={() => onDecision(true)} disabled={starting}>
          {starting ? (
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
          ) : (
            <Camera className="w-4 h-4 me-2" />
          )}
          {tr("quiz.203")}
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => onDecision(false)}
          disabled={starting}
        >
          <CameraOff className="w-4 h-4 me-2" />
          {tr("quiz.210")}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Runs the camera for the lifetime of an attempt and periodically posts
 * snapshots. Render it inside the quiz; it shows a small self-view badge.
 */
export function QuizCameraMonitor({
  quizId,
  attemptId,
  enabled,
  onStatusChange,
}: {
  quizId: string;
  attemptId: string;
  /** false => student declined; no camera is ever touched. */
  enabled: boolean;
  onStatusChange?: (status: CameraStatus) => void;
}) {
  const tr = useT();
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const [status, setStatus] = React.useState<CameraStatus>(
    enabled ? "NOT_REQUESTED" : "DECLINED"
  );

  const report = React.useCallback(
    (next: CameraStatus) => {
      setStatus(next);
      onStatusChange?.(next);
      // Status-only ping — carries no media.
      fetch(`/api/quizzes/${quizId}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "STATUS", attemptId, status: next }),
        keepalive: true,
      }).catch(() => {});
    },
    [quizId, attemptId, onStatusChange]
  );

  // --- Acquire / release the stream -------------------------------------
  React.useEffect(() => {
    if (!enabled) {
      report("DECLINED");
      return;
    }
    let cancelled = false;

    (async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        report("UNAVAILABLE");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Video only — audio is never captured.
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        // If the user revokes the camera mid-quiz we must notice.
        stream.getVideoTracks().forEach((t) => {
          t.addEventListener("ended", () => report("INTERRUPTED"));
        });
        report("GRANTED");
      } catch (e: any) {
        const name = e?.name || "";
        report(
          name === "NotAllowedError" || name === "SecurityError"
            ? "DENIED"
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "UNAVAILABLE"
              : "INTERRUPTED"
        );
      }
    })();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // `report` is stable via useCallback on stable inputs.
  }, [enabled, report]);

  // --- Periodic snapshots -----------------------------------------------
  React.useEffect(() => {
    if (status !== "GRANTED") return;

    const capture = async () => {
      const video = videoRef.current;
      const stream = streamRef.current;
      if (!video || !stream || video.readyState < 2) return;
      const canvas = document.createElement("canvas");
      const scale = SNAPSHOT_WIDTH / (video.videoWidth || SNAPSHOT_WIDTH);
      canvas.width = SNAPSHOT_WIDTH;
      canvas.height = Math.round((video.videoHeight || 240) * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.6)
      );
      if (!blob) return;
      const form = new FormData();
      form.set("kind", "SNAPSHOT");
      form.set("attemptId", attemptId);
      form.set("file", blob, "snapshot.jpg");
      // Best effort: a failed snapshot must never break the quiz.
      fetch(`/api/quizzes/${quizId}/evidence`, { method: "POST", body: form }).catch(
        () => {}
      );
    };

    // One shortly after start, then on a slow interval.
    const first = window.setTimeout(capture, 5_000);
    const timer = window.setInterval(capture, SNAPSHOT_INTERVAL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [status, quizId, attemptId]);

  if (!enabled) return null;

  const label =
    status === "GRANTED"
      ? tr("quiz.205")
      : status === "DENIED"
        ? tr("quiz.206")
        : status === "UNAVAILABLE"
          ? tr("quiz.207")
          : status === "INTERRUPTED"
            ? tr("quiz.208")
            : tr("quiz.211");

  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/80 p-2 shadow-sm">
      {/* Always-visible self-view: the student can see exactly what is captured. */}
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label={tr("quiz.211")}
        className={`h-12 w-16 rounded-lg bg-muted object-cover ${
          status === "GRANTED" ? "" : "opacity-40"
        }`}
      />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold">
          <span
            aria-hidden
            className={`inline-block w-2 h-2 rounded-full ${
              status === "GRANTED" ? "animate-pulse bg-red-500" : "bg-muted-foreground/50"
            }`}
          />
          <span className="truncate">{label}</span>
        </div>
        <p className="text-[10px] text-muted-foreground">{tr("quiz.211")}</p>
      </div>
    </div>
  );
}
