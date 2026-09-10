"use client";

// ============================================================
// CodeMind Academy — Admin: session PDF manager (Phase 14 API)
//
// Upload / replace / deactivate over the EXISTING material API
// (`GET|POST|DELETE /api/admin/lessons/[id]/materials`). Shows file
// metadata, track scope and active state from the server payload; storage
// internals are never exposed (the API does not return them).
//
// Every mutation refreshes the whole detail screen through `onChanged`,
// so readiness and history stay in sync with the new material state.
// ============================================================

import * as React from "react";
import { toast } from "sonner";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Upload, Download, RefreshCw, Loader2, FileText } from "lucide-react";
import {
  ConfirmDialog,
  TrackScopeBadge,
  fetchJson,
  formatBytes,
  formatDateTime,
  serverErrorText,
  type AdminSessionMaterialSummary,
} from "@/components/admin/session-workflow-shared";

export function SessionPdfManager({
  lessonId,
  lessonTrackScope,
  materials,
  onChanged,
}: {
  lessonId: string;
  lessonTrackScope: string;
  materials: AdminSessionMaterialSummary[];
  onChanged: () => void;
}) {
  const tr = useT();
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [scope, setScope] = React.useState<string>("INHERIT");
  const [uploading, setUploading] = React.useState(false);
  const [deactivateTarget, setDeactivateTarget] =
    React.useState<AdminSessionMaterialSummary | null>(null);
  const [deactivating, setDeactivating] = React.useState(false);
  const replaceInputRef = React.useRef<HTMLInputElement>(null);
  const [replaceScope, setReplaceScope] = React.useState<string | null>(null);

  const upload = async (f: File | null, explicitScope: string | null, customTitle: string) => {
    if (!f) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", f);
      if (customTitle.trim()) form.append("title", customTitle.trim());
      // INHERIT omits the field: the server defaults to the lesson's scope.
      if (explicitScope && explicitScope !== "INHERIT") {
        form.append("trackScope", explicitScope);
      }
      const res = await fetchJson<{ material: { id: string } }>(
        `/api/admin/lessons/${encodeURIComponent(lessonId)}/materials`,
        { method: "POST", body: form }
      );
      if (!res.ok) {
        toast.error(serverErrorText(tr, res.error));
        return;
      }
      toast.success(tr("admin.424"));
      setFile(null);
      setTitle("");
      onChanged();
    } finally {
      setUploading(false);
      setReplaceScope(null);
    }
  };

  const deactivate = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      const res = await fetchJson<{ ok: boolean }>(
        `/api/admin/lessons/${encodeURIComponent(lessonId)}/materials?materialId=${encodeURIComponent(deactivateTarget.id)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        toast.error(serverErrorText(tr, res.error));
        return;
      }
      toast.success(tr("admin.425"));
      setDeactivateTarget(null);
      onChanged();
    } finally {
      setDeactivating(false);
    }
  };

  const active = materials.filter((m) => m.isActive);
  const inactive = materials.filter((m) => !m.isActive);

  return (
    <div className="space-y-3">
      {/* Upload */}
      <div className="grid gap-2 rounded-lg border p-3 md:grid-cols-[1fr_auto_auto_auto] md:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="pdf-file">{tr("admin.420")}</Label>
          <Input
            id="pdf-file"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={uploading}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pdf-title">{tr("admin.356")}</Label>
          <Input
            id="pdf-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={file?.name || tr("admin.429")}
            disabled={uploading}
            className="md:w-44"
          />
        </div>
        <div className="grid gap-1.5">
          <Label>{tr("admin.430")}</Label>
          <Select value={scope} onValueChange={setScope} disabled={uploading}>
            <SelectTrigger className="md:w-40" aria-label={tr("admin.430")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="INHERIT">
                {tr("admin.431")} ({lessonTrackScope})
              </SelectItem>
              <SelectItem value="SHARED">{tr("admin.349")}</SelectItem>
              <SelectItem value="ARABIC">{tr("admin.350")}</SelectItem>
              <SelectItem value="LANGUAGE">{tr("admin.351")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => upload(file, scope, title)} disabled={!file || uploading}>
          {uploading ? (
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
          ) : (
            <Upload className="w-4 h-4 me-2" />
          )}
          {uploading ? tr("admin.423") : tr("admin.420")}
        </Button>
      </div>

      {/* Active materials */}
      {active.length === 0 ? (
        <p className="py-2 text-center text-sm text-muted-foreground">{tr("admin.426")}</p>
      ) : (
        <div className="space-y-2">
          {active.map((m) => (
            <MaterialRow
              key={m.id}
              material={m}
              onReplace={() => {
                // Replace = upload into the SAME scope; the server deactivates
                // the prior active row of that scope.
                setReplaceScope(m.trackScope);
                replaceInputRef.current?.click();
              }}
              onDeactivate={() => setDeactivateTarget(m)}
            />
          ))}
        </div>
      )}

      {/* Deactivated history (auditable, not downloadable) */}
      {inactive.length > 0 && (
        <details className="rounded-lg border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-muted-foreground">
            {tr("admin.292")} ({inactive.length})
          </summary>
          <div className="space-y-2 px-3 pb-3">
            {inactive.map((m) => (
              <MaterialRow key={m.id} material={m} />
            ))}
          </div>
        </details>
      )}

      {/* Hidden picker for per-row replace */}
      <input
        ref={replaceInputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = "";
          if (f && replaceScope) upload(f, replaceScope, "");
          else setReplaceScope(null);
        }}
      />

      <ConfirmDialog
        open={!!deactivateTarget}
        onOpenChange={(v) => !v && setDeactivateTarget(null)}
        title={tr("admin.298")}
        description={deactivateTarget?.title || ""}
        confirmLabel={tr("admin.298")}
        confirmingLabel={tr("admin.377")}
        confirming={deactivating}
        danger
        onConfirm={deactivate}
      />
    </div>
  );
}

function MaterialRow({
  material: m,
  onReplace,
  onDeactivate,
}: {
  material: AdminSessionMaterialSummary;
  onReplace?: () => void;
  onDeactivate?: () => void;
}) {
  const tr = useT();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-2.5">
      <div className="grid place-items-center w-8 h-8 shrink-0 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400">
        <FileText className="w-4 h-4" />
      </div>
      <div className="min-w-0 flex-1 basis-40">
        <div className="truncate text-sm font-semibold">{m.title}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span dir="ltr">{m.mimeType || "application/pdf"}</span>
          <span dir="ltr">{formatBytes(m.sizeBytes)}</span>
          {m.originalName && <span className="truncate max-w-44" dir="auto">{m.originalName}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <TrackScopeBadge scope={m.trackScope} />
          <Badge variant={m.isActive ? "default" : "secondary"} className="text-[10px]">
            {m.isActive ? tr("admin.291") : tr("admin.292")}
          </Badge>
          <span className="text-[10px] text-muted-foreground">{formatDateTime(m.createdAt)}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 ms-auto">
        {m.isActive && m.downloadUrl && (
          <Button size="sm" variant="outline" asChild>
            <a href={m.downloadUrl} target="_blank" rel="noreferrer">
              <Download className="w-3.5 h-3.5 me-1" />
              {tr("admin.478")}
            </a>
          </Button>
        )}
        {onReplace && (
          <Button size="sm" variant="outline" onClick={onReplace}>
            <RefreshCw className="w-3.5 h-3.5 me-1" />
            {tr("admin.421")}
          </Button>
        )}
        {onDeactivate && (
          <Button size="sm" variant="ghost" onClick={onDeactivate}>
            {tr("admin.298")}
          </Button>
        )}
      </div>
    </div>
  );
}
