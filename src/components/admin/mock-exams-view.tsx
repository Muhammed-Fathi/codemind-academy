"use client";

// ============================================================
// CodeMind Academy — Admin: Mock Exams
//
// When creating an exam the admin MUST pick a student type (Arabic School or
// Language School). That choice binds the exam to the matching question bank:
// at attempt time only questions tagged with that school type — or explicitly
// shared — can be selected, so an Arabic exam can never serve Language-school
// questions and vice versa.
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useT, pickAuto } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { Plus, Timer, Trash2, Loader2, Library } from "lucide-react";

type MockExam = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  schoolType: "ARABIC" | "LANGUAGE";
  course: { id: string; name: string; nameAr: string } | null;
  questionCount: number;
  durationMin: number;
  passMark: number;
  difficulty: string;
  selectionMode: string;
  isPublished: boolean;
  pinnedQuestions: number;
  attempts: number;
};

const TYPE_TABS = [
  { value: "ARABIC", labelKey: "admin.200" },
  { value: "LANGUAGE", labelKey: "admin.201" },
] as const;

export function MockExamsView() {
  const tr = useT();
  const [schoolType, setSchoolType] = React.useState<"ARABIC" | "LANGUAGE">("ARABIC");
  const [exams, setExams] = React.useState<MockExam[]>([]);
  const [pools, setPools] = React.useState<{ ARABIC: number; LANGUAGE: number }>({
    ARABIC: 0,
    LANGUAGE: 0,
  });
  const [loading, setLoading] = React.useState(true);
  const [openCreate, setOpenCreate] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/mock-exams?schoolType=${schoolType}`);
      const d = await r.json();
      setExams(d.exams || []);
      setPools(d.pools || { ARABIC: 0, LANGUAGE: 0 });
    } catch {
      toast.error(tr("admin.001"));
    } finally {
      setLoading(false);
    }
  }, [schoolType, tr]);

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{tr("admin.214")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.216")}</p>
        </div>
        <Button onClick={() => setOpenCreate(true)}>
          <Plus className="w-4 h-4 me-2" />
          {tr("admin.215")}
        </Button>
      </div>

      <Card className="p-4">
        {/* Student-type selector = question bank selector. */}
        <div
          role="tablist"
          aria-label={tr("admin.203")}
          className="flex flex-wrap items-center gap-2 mb-4 border-b border-border/60 pb-3"
        >
          {TYPE_TABS.map((tab) => {
            const active = schoolType === tab.value;
            return (
              <button
                key={tab.value}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setSchoolType(tab.value)}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                }`}
              >
                <span>{tr(tab.labelKey)}</span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                    active ? "bg-primary-foreground/20" : "bg-background"
                  }`}
                >
                  {pools[tab.value]}
                </span>
              </button>
            );
          })}
        </div>

        <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Library className="w-3.5 h-3.5 shrink-0" />
          {tr("admin.244")}: {pools[schoolType]}
        </p>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : exams.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {tr("admin.240")}
          </p>
        ) : (
          <div className="space-y-2">
            {exams.map((e) => (
              <div
                key={e.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
              >
                <div className="grid place-items-center w-9 h-9 shrink-0 rounded-lg bg-primary/10 text-primary">
                  <Timer className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {pickAuto(e.titleAr, e.title)}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Badge variant="outline" className="text-[10px]">
                      {tr(e.schoolType === "ARABIC" ? "admin.200" : "admin.201")}
                    </Badge>
                    <span>
                      {tr("admin.217")}: {e.questionCount}
                    </span>
                    <span>
                      · {tr("admin.218")}: {e.durationMin}
                    </span>
                    <span>
                      · {tr("admin.219")}: {e.passMark}%
                    </span>
                    <span>· {e.attempts} attempts</span>
                  </div>
                </div>
                <Badge
                  className={
                    e.isPublished
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                      : ""
                  }
                  variant={e.isPublished ? "default" : "secondary"}
                >
                  {tr(e.isPublished ? "admin.211" : "admin.212")}
                </Badge>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const r = await fetch(`/api/admin/mock-exams/${e.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ isPublished: !e.isPublished }),
                      });
                      const d = await r.json();
                      if (!r.ok) {
                        toast.error(d.error || tr("admin.001"));
                        return;
                      }
                      load();
                    }}
                  >
                    {tr(e.isPublished ? "admin.243" : "admin.242")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={tr("admin.038")}
                    onClick={async () => {
                      await fetch(`/api/admin/mock-exams/${e.id}`, { method: "DELETE" });
                      load();
                    }}
                  >
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <CreateMockExamDialog
        open={openCreate}
        onOpenChange={setOpenCreate}
        defaultSchoolType={schoolType}
        onCreated={load}
      />
    </motion.div>
  );
}

function CreateMockExamDialog({
  open,
  onOpenChange,
  defaultSchoolType,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultSchoolType: "ARABIC" | "LANGUAGE";
  onCreated: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({
    title: "",
    titleAr: "",
    description: "",
    schoolType: defaultSchoolType as string,
    questionCount: "10",
    durationMin: "30",
    passMark: "60",
    difficulty: "MIXED",
    selectionMode: "RANDOM",
  });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setForm((f) => ({ ...f, schoolType: defaultSchoolType }));
  }, [defaultSchoolType, open]);

  const submit = async () => {
    if (!form.title.trim()) {
      toast.error(tr("api.187"));
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/admin/mock-exams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          titleAr: form.titleAr || form.title,
          questionCount: Number(form.questionCount),
          durationMin: Number(form.durationMin),
          passMark: Number(form.passMark),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || tr("admin.001"));
      toast.success(tr("admin.241"));
      onCreated();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr("admin.215")}</DialogTitle>
          <DialogDescription>{tr("admin.216")}</DialogDescription>
        </DialogHeader>
        <div className="form-scroll space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="me-title">{tr("admin.250")} (EN)</Label>
              <Input
                id="me-title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="me-title-ar">{tr("admin.250")} (AR)</Label>
              <Input
                id="me-title-ar"
                value={form.titleAr}
                onChange={(e) => setForm({ ...form, titleAr: e.target.value })}
                className="mt-1"
              />
            </div>
          </div>

          {/* Student type — decides WHICH question bank the exam pulls from. */}
          <div>
            <Label>{tr("admin.203")}</Label>
            <Select
              value={form.schoolType}
              onValueChange={(v) => setForm({ ...form, schoolType: v })}
            >
              <SelectTrigger className="mt-1 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ARABIC">{tr("admin.200")}</SelectItem>
                <SelectItem value="LANGUAGE">{tr("admin.201")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="me-count">{tr("admin.217")}</Label>
              <Input
                id="me-count"
                type="number"
                min={1}
                max={100}
                value={form.questionCount}
                onChange={(e) => setForm({ ...form, questionCount: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="me-duration">{tr("admin.218")}</Label>
              <Input
                id="me-duration"
                type="number"
                min={5}
                max={300}
                value={form.durationMin}
                onChange={(e) => setForm({ ...form, durationMin: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label htmlFor="me-pass">{tr("admin.219")}</Label>
              <Input
                id="me-pass"
                type="number"
                min={0}
                max={100}
                value={form.passMark}
                onChange={(e) => setForm({ ...form, passMark: e.target.value })}
                className="mt-1"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{tr("admin.164")}</Label>
              <Select
                value={form.difficulty}
                onValueChange={(v) => setForm({ ...form, difficulty: v })}
              >
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MIXED">{tr("admin.165")}</SelectItem>
                  <SelectItem value="EASY">{tr("admin.166")}</SelectItem>
                  <SelectItem value="MEDIUM">{tr("admin.167")}</SelectItem>
                  <SelectItem value="HARD">{tr("admin.168")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{tr("admin.216")}</Label>
              <Select
                value={form.selectionMode}
                onValueChange={(v) => setForm({ ...form, selectionMode: v })}
              >
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="RANDOM">Random</SelectItem>
                  <SelectItem value="FIXED">Fixed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="me-desc">{tr("admin.249")}</Label>
            <Textarea
              id="me-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              className="mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr("admin.038")}
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {tr("admin.215")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
