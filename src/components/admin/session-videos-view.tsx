"use client";

// ============================================================
// CodeMind Academy — Admin: Session Video management
//
// Batches are school-type based (Arabic School / Language School). The admin
// opens a batch, supplies EITHER an uploaded video file OR a video URL, and
// publishes once — the media is stored a single time and becomes available to
// every eligible student of that batch. No per-student copies are made.
//
// All spacing/alignment uses logical properties so the layout is correct in
// both Arabic (RTL) and English (LTR).
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useT, useLocale, pickAuto } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, Upload, Link2, Video, Trash2, Loader2, CheckCircle2 } from "lucide-react";
import { uploadFailureMessage } from "@/lib/upload-error-text";
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
  course: { id: string; name: string; nameAr: string } | null;
  isActive: boolean;
  members: number;
  videos: number;
};

type SessionVideo = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  batch: { id: string; name: string; nameAr: string; schoolType: string };
  lesson: { id: string; title: string; titleAr: string } | null;
  requiredPercent: number;
  isPublished: boolean;
  publishedAt: string | null;
  source: "URL" | "UPLOAD";
  externalUrl: string | null;
  streamUrl: string | null;
  viewers: number;
};

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
  const [loading, setLoading] = React.useState(true);
  const [loadingVideos, setLoadingVideos] = React.useState(false);

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

  React.useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  React.useEffect(() => {
    if (activeBatchId) loadVideos(activeBatchId);
  }, [activeBatchId, loadVideos]);

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
            onPublished={() => {
              loadVideos(activeBatch.id);
              loadBatches();
            }}
          />

          <Card className="p-4">
            <CardHeader className="p-0 pb-3">
              <CardTitle className="text-base">
                {pickAuto(activeBatch.nameAr, activeBatch.name)}
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
                      <div className="flex items-center gap-1.5">
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

/** Upload-or-URL publishing form. Both methods are first-class. */
function PublishVideoCard({
  batch,
  onPublished,
}: {
  batch: Batch;
  onPublished: () => void;
}) {
  const tr = useT();
  const [method, setMethod] = React.useState<"UPLOAD" | "URL">("URL");
  const [title, setTitle] = React.useState("");
  const [titleAr, setTitleAr] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [videoUrl, setVideoUrl] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [saving, setSaving] = React.useState(false);
  // Phase 23 UX — the SAME state machine the session-PDF screen uses, so a
  // video upload and a PDF upload show identical phases, identical REAL byte
  // progress and identical failure wording.
  const uploader = useMediaUpload();
  /** Remembered so a retry reports the same publish/draft outcome. */
  const lastPublishRef = React.useRef(false);
  const busy = saving || uploader.isBusy;
  /** The publish button names the phase it is in, not a generic "saving". */
  const uploadLabel = uploader.isBusy ? tr("admin.423") : tr("admin.210");

  const reset = () => {
    setTitle("");
    setTitleAr("");
    setDescription("");
    setVideoUrl("");
    setFile(null);
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
          initFields: { batchId: batch.id },
          completeFields: {
            batchId: batch.id,
            title,
            titleAr: titleAr || title,
            description,
            publish,
          },
          // No browser-side hash for videos: a 512 MB buffer just to hash it
          // is worse than skipping the optional integrity proof.
          sha256: null,
        },
        async (f) => {
          const form = new FormData();
          form.set("batchId", batch.id);
          form.set("title", title);
          form.set("titleAr", titleAr || title);
          form.set("description", description);
          form.set("publish", String(publish));
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
          title,
          titleAr: titleAr || title,
          description,
          videoUrl,
          publish,
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
