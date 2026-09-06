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

  const reset = () => {
    setTitle("");
    setTitleAr("");
    setDescription("");
    setVideoUrl("");
    setFile(null);
  };

  const submit = async (publish: boolean) => {
    if (!title.trim()) {
      toast.error(tr("admin.179"));
      return;
    }
    if (method === "URL" && !videoUrl.trim()) {
      toast.error(tr("api.219"));
      return;
    }
    if (method === "UPLOAD" && !file) {
      toast.error(tr("api.219"));
      return;
    }
    setSaving(true);
    try {
      let res: Response;
      if (method === "UPLOAD") {
        const form = new FormData();
        form.set("batchId", batch.id);
        form.set("title", title);
        form.set("titleAr", titleAr || title);
        form.set("description", description);
        form.set("publish", String(publish));
        form.set("file", file!);
        res = await fetch("/api/admin/session-videos", { method: "POST", body: form });
      } else {
        res = await fetch("/api/admin/session-videos", {
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
      }
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
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="sv-title-ar">{tr("admin.235")} (AR)</Label>
            <Input
              id="sv-title-ar"
              value={titleAr}
              onChange={(e) => setTitleAr(e.target.value)}
              className="mt-1"
            />
          </div>
        </div>

        {method === "URL" ? (
          <div>
            <Label htmlFor="sv-url">{tr("admin.209")}</Label>
            <Input
              id="sv-url"
              value={videoUrl}
              onChange={(e) => setVideoUrl(e.target.value)}
              placeholder="https://..."
              dir="ltr"
              className="mt-1"
            />
          </div>
        ) : (
          <div>
            <Label htmlFor="sv-file">{tr("admin.208")}</Label>
            <Input
              id="sv-file"
              type="file"
              accept="video/mp4,video/webm,video/ogg,video/quicktime"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="mt-1"
            />
          </div>
        )}

        <div>
          <Label htmlFor="sv-desc">{tr("admin.249")}</Label>
          <Textarea
            id="sv-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="mt-1"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={() => submit(true)} disabled={saving}>
            {saving ? (
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
            ) : (
              <CheckCircle2 className="w-4 h-4 me-2" />
            )}
            {tr("admin.210")}
          </Button>
          <Button variant="outline" onClick={() => submit(false)} disabled={saving}>
            {tr("admin.212")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
