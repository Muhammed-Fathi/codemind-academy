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
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Timer, Trash2, Loader2, Library, AlertTriangle, CheckCircle2 } from "lucide-react";

type MockExam = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  schoolType: "ARABIC" | "LANGUAGE";
  course: { id: string; name: string; nameAr: string } | null;
  courseId: string | null;
  eligiblePool: number;
  questionCount: number;
  durationMin: number;
  passMark: number;
  difficulty: string;
  selectionMode: string;
  isPublished: boolean;
  /** FIXED: pins. RANDOM: free-bank questions attached to the exam. */
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
                    <Badge variant="outline" className="text-[10px]">
                      {tr("admin.463")}:{" "}
                      {tr(e.selectionMode === "FIXED" ? "admin.464" : "admin.465")}
                    </Badge>
                    {e.selectionMode !== "FIXED" && (
                      <span
                        className={
                          e.eligiblePool < e.questionCount
                            ? "text-amber-700 dark:text-amber-300 font-semibold"
                            : ""
                        }
                        title={
                          e.eligiblePool < e.questionCount
                            ? tr("admin.543")
                            : undefined
                        }
                      >
                        {tr("admin.547", { p1: e.eligiblePool })}
                        {e.eligiblePool < e.questionCount && ` · ${tr("admin.552")}`}
                      </span>
                    )}
                    {e.selectionMode === "FIXED" && (
                      <span
                        className={
                          e.pinnedQuestions < e.questionCount
                            ? "text-amber-700 dark:text-amber-300 font-semibold"
                            : ""
                        }
                        title={
                          e.pinnedQuestions < e.questionCount ? tr("admin.462") : undefined
                        }
                      >
                        {tr("admin.460")}:{" "}
                        {tr("admin.461", { p1: e.pinnedQuestions, p2: e.questionCount })}
                        {e.pinnedQuestions < e.questionCount && ` · ${tr("admin.462")}`}
                      </span>
                    )}
                    {e.selectionMode !== "FIXED" && e.pinnedQuestions > 0 && (
                      <span>
                        {tr("admin.560")}: {e.pinnedQuestions}
                      </span>
                    )}
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

type PickerQuestion = {
  id: string;
  prompt: string;
  promptAr: string | null;
  difficulty: string;
  marks: number;
  schoolType: string | null;
  bankOnly: boolean;
  lessonTitle: string | null;
};

type EligiblePool = {
  total: number;
  question: number;
  examQuestion: number;
  bankOnly: number;
  lessonLinked: number;
  /** What a RANDOM exam of the chosen difficulty will really serve from. */
  servable: number;
  byDifficulty: { EASY: number; MEDIUM: number; HARD: number };
};

// Create a mock exam. The dialog is mode-aware on purpose:
//   RANDOM → shows the number of questions AND how many are actually eligible
//            in the chosen bank, and refuses to create an exam the bank cannot
//            satisfy (clear Arabic error instead of an unservable exam).
//   FIXED  → the admin selects the exact questions from the bank; those ids
//            are pinned server-side and served unchanged to every student.
// The AI generator is never required: any valid Question Bank row — manual or
// AI-generated — is eligible.
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
    /** "" = the exam is not bound to a course (a general exam). */
    courseId: "",
    questionCount: "10",
    durationMin: "30",
    passMark: "60",
    difficulty: "MIXED",
    selectionMode: "RANDOM",
  });
  // The courses an exam can be bound to. A course-bound exam is visible only
  // to that course's students, and its RANDOM pool is that course's questions
  // (plus any manual question attached to the exam).
  const [courses, setCourses] = React.useState<
    { id: string; name: string; nameAr: string }[]
  >([]);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/admin/courses")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setCourses(d.courses || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);
  const [saving, setSaving] = React.useState(false);
  // Data + the request key it belongs to. The key makes "loading" DERIVED
  // (current key not answered yet) instead of a second piece of state, so the
  // effects below never call setState synchronously.
  const [poolData, setPoolData] = React.useState<{
    key: string;
    pool: EligiblePool | null;
  } | null>(null);
  const [listData, setListData] = React.useState<{
    key: string;
    items: PickerQuestion[];
  } | null>(null);
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [search, setSearch] = React.useState("");

  const isFixed = form.selectionMode === "FIXED";
  const requestedCount = Math.max(1, Number(form.questionCount) || 1);
  const poolKey = `${form.schoolType}|${form.difficulty}|${form.courseId}`;
  const pool = poolData && poolData.key === poolKey ? poolData.pool : null;
  const poolLoading = poolData?.key !== poolKey;
  const listKey = `${poolKey}|${search.trim()}|${isFixed ? "fixed" : "pool"}`;
  const listLoading = listData?.key !== listKey;
  const candidates = listData && listData.key === listKey ? listData.items : [];
  // FIXED — the questions to pin. RANDOM — the free-bank rows to attach.
  const showPicker = isFixed || form.selectionMode === "RANDOM";

  React.useEffect(() => {
    setForm((f) => ({ ...f, schoolType: defaultSchoolType }));
  }, [defaultSchoolType, open]);

  // The eligible pool for the chosen bank + difficulty: the SAME pool the
  // student attempt path serves from (bank-only questions + questions of a
  // student-visible lesson).
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const qs = new URLSearchParams({
      schoolType: form.schoolType,
      difficulty: form.difficulty,
    });
    if (form.courseId) qs.set("courseId", form.courseId);
    fetch(`/api/admin/mock-exams/eligible?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setPoolData({ key: poolKey, pool: d.pool || null });
      })
      .catch(() => {
        if (!cancelled) setPoolData({ key: poolKey, pool: null });
      });
    return () => {
      cancelled = true;
    };
    // `poolKey` is the (schoolType, difficulty, course) triple the request was
    // built from — listing it keeps the dependency list honest.
  }, [open, form.schoolType, form.difficulty, form.courseId, poolKey]);

  // The candidate questions for the chosen mode: FIXED pins (`list=1`) or the
  // free-bank rows a RANDOM exam may attach (`list=pool`). Both are key-free.
  React.useEffect(() => {
    if (!open || !showPicker) return;
    let cancelled = false;
    const qs = new URLSearchParams({
      schoolType: form.schoolType,
      difficulty: form.difficulty,
      list: isFixed ? "1" : "pool",
    });
    if (form.courseId) qs.set("courseId", form.courseId);
    if (search.trim()) qs.set("search", search.trim());
    fetch(`/api/admin/mock-exams/eligible?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setListData({ key: listKey, items: d.questions || [] });
      })
      .catch(() => {
        if (!cancelled) setListData({ key: listKey, items: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [
    open,
    isFixed,
    showPicker,
    form.schoolType,
    form.difficulty,
    form.courseId,
    search,
    listKey,
  ]);

  const toggleSelected = (id: string) => {
    setSelectedIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    );
  };

  // RANDOM is refused when the bank cannot serve the requested count — the
  // number shown here is the pool the student attempt will really sample.
  // FIXED instead needs at least one pickable question.
  const availableForMode = pool ? (isFixed ? pool.question : pool.servable) : 0;
  // RANDOM: the attached free-bank rows are added to the pool the moment the
  // exam is saved, so the count the dialog shows is the pool it starts with,
  // plus the rows the admin is attaching right now. The server re-measures the
  // real pool after the attachments are stored and refuses a short exam.
  const availableWithAttachments = isFixed
    ? availableForMode
    : availableForMode + selectedIds.length;
  const poolTooSmall =
    pool !== null && availableWithAttachments < (isFixed ? 1 : requestedCount);
  const selectedTooFew = isFixed && selectedIds.length === 0;
  // Phase K2 — a mock exam is curriculum-bound: the course is REQUIRED (the
  // server refuses a course-less exam with api.376).
  const courseMissing = !form.courseId;
  const blocked = saving || poolTooSmall || selectedTooFew || courseMissing;

  const submit = async () => {
    if (!form.title.trim()) {
      toast.error(tr("api.187"));
      return;
    }
    if (!form.courseId) {
      toast.error(tr("api.376"));
      return;
    }
    if (selectedTooFew) {
      toast.error(tr("admin.549"));
      return;
    }
    if (pool && !isFixed && requestedCount > availableWithAttachments) {
      toast.error(tr("admin.550", { p1: availableWithAttachments }));
      return;
    }
    if (pool && isFixed && selectedIds.length > pool.question) {
      toast.error(tr("admin.550", { p1: pool.question }));
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
          questionCount: isFixed ? selectedIds.length : Number(form.questionCount),
          durationMin: Number(form.durationMin),
          passMark: Number(form.passMark),
          // FIXED: pin exactly the admin's selection. RANDOM: attach the
          // chosen free-bank questions to THIS exam's pool. Either way the
          // server re-validates that every id is a bank row of this exam's
          // scope.
          ...(selectedIds.length ? { questionIds: selectedIds } : {}),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || tr("admin.001"));
      toast.success(tr("admin.241"));
      onCreated();
      onOpenChange(false);
      setSelectedIds([]);
      setSearch("");
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
              onValueChange={(v) => {
                setForm({ ...form, schoolType: v });
                setSelectedIds([]);
              }}
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

          {/* Course scope — REQUIRED (Phase K2): a mock exam is bound to one
              course, is visible only to that course's students and samples
              that course's lesson questions; manual free-bank questions still
              have to be attached to THIS exam. There is no "all courses"
              option any more — that scope would span every academic level. */}
          <div>
            <Label>{tr("admin.647")}</Label>
            <Select
              value={form.courseId || ""}
              onValueChange={(v) => {
                setForm({ ...form, courseId: v });
                setSelectedIds([]);
                setListData(null);
              }}
            >
              <SelectTrigger className="mt-1 w-full">
                <SelectValue placeholder={tr("admin.647")} />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {pickAuto(c.nameAr, c.name)}
                  </SelectItem>
                ))}
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
                value={isFixed ? String(selectedIds.length || 1) : form.questionCount}
                disabled={isFixed}
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
                onValueChange={(v) => {
                  setForm({ ...form, difficulty: v });
                  setSelectedIds([]);
                }}
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
              <Label>{tr("admin.539")}</Label>
              <Select
                value={form.selectionMode}
                onValueChange={(v) => setForm({ ...form, selectionMode: v })}
              >
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="RANDOM">{tr("admin.465")}</SelectItem>
                  <SelectItem value="FIXED">{tr("admin.464")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Mode explanation + eligible pool count. */}
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed space-y-2">
            <p>{tr(isFixed ? "admin.540" : "admin.541")}</p>
            <p className="flex items-center gap-1.5">
              {poolLoading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : pool && pool.total > 0 ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              )}
              <span className="font-semibold">
                {tr(isFixed ? "admin.553" : "admin.555")}:
              </span>
              <span className="tabular-nums">
                {pool ? (isFixed ? availableForMode : availableWithAttachments) : "—"}
              </span>
            </p>
            {pool && (
              <p className="text-muted-foreground tabular-nums">
                {tr("admin.554", {
                  p1: pool.total,
                  p2: pool.bankOnly,
                  p3: pool.byDifficulty.EASY,
                  p4: pool.byDifficulty.MEDIUM,
                  p5: pool.byDifficulty.HARD,
                })}
              </p>
            )}
            <p className="text-muted-foreground">{tr("admin.545")}</p>
            {!isFixed && <p className="text-muted-foreground">{tr("admin.561")}</p>}
            <p className="text-muted-foreground">{tr("admin.546")}</p>
          </div>

          {poolTooSmall && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs font-semibold text-amber-800 dark:text-amber-200">
              {tr("admin.550", { p1: availableWithAttachments })}
            </div>
          )}

          {/* FIXED: pin the exact questions. RANDOM: attach free-bank rows to
              this exam's pool — the only way a manual question enters it. */}
          {showPicker && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>{tr(isFixed ? "admin.544" : "admin.556")}</Label>
                <span className="text-xs text-muted-foreground">
                  {tr("admin.548", { p1: selectedIds.length })}
                  {isFixed && pool ? ` / ${pool.question}` : ""}
                </span>
              </div>
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tr("admin.015")}
              />
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-border/60 p-2">
                {listLoading ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="w-4 h-4 animate-spin" />
                  </div>
                ) : candidates.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    {tr(isFixed ? "admin.240" : "admin.557")}
                  </p>
                ) : (
                  candidates.map((q) => {
                    const checked = selectedIds.includes(q.id);
                    return (
                      <label
                        key={q.id}
                        className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleSelected(q.id)}
                          className="mt-0.5"
                        />
                        <span className="min-w-0 flex-1 text-xs">
                          <span className="block truncate font-medium">
                            {pickAuto(q.promptAr, q.prompt)}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                            <Badge variant="outline" className="text-[10px]">
                              {q.difficulty}
                            </Badge>
                            <Badge variant="outline" className="text-[10px]">
                              {q.marks} {tr("admin.219")}
                            </Badge>
                            <span>
                              {q.bankOnly
                                ? tr("admin.244")
                                : q.lessonTitle || ""}
                            </span>
                          </span>
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          )}

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
          <Button onClick={submit} disabled={blocked}>
            {saving && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {tr("admin.215")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
