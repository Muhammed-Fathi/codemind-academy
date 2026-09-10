"use client";

// ============================================================
// CodeMind Academy — Teacher authoring surface (Phase 18)
//
// Shared, self-contained pieces the teacher dashboard composes:
//
//   * `useTeacherLessons`   — the canonical lesson catalogue for the picker
//   * `LessonPicker`        — officialCode · Part · Unit · title · trackScope
//                             · lifecycle, canonical AND legacy chains
//   * `HomeworkDialog`      — create AND edit an assignment
//   * `QuestionManagerDialog` — list / append / edit / delete a quiz's
//                             questions, honouring the server's guards
//   * `TrackSplitRow`       — the minimal track-aware analytics row
//
// The client NEVER decides authorization or scope validity: every control
// either renders what the server returned (`canDelete`, `canEditAnswerKey`,
// `references`, `deleteBlockers`) or sends the choice to the server and
// surfaces the refusal. Nothing is inferred from a lesson's fields.
// ============================================================

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CurriculumBadge,
  StatusBadge,
  TrackScopeBadge,
} from "@/components/admin/session-workflow-shared";
import { useT } from "@/lib/i18n";
import { Plus, Save, Trash2, RefreshCw } from "lucide-react";

// ---------------------------------------------------------------------------
// Types — mirrors of the Phase 18 API payloads
// ---------------------------------------------------------------------------

export type TeacherLesson = {
  id: string;
  title: string;
  titleRaw: string;
  titleAr: string;
  order: number;
  officialCode: string | null;
  trackScope: string;
  status: string;
  curriculumStatus: string;
  archived: boolean;
  chain: "CANONICAL" | "LEGACY";
  course: { id: string; name: string };
  part: { id: string; title: string; order: number };
  unit: { id: string; title: string; order: number };
  topic: { id: string; title: string } | null;
};

export type LessonGroupNode = {
  id: string;
  name: string;
  parts: Array<{
    id: string;
    title: string;
    titleAr: string;
    units: Array<{
      id: string;
      title: string;
      titleAr: string;
      lessons: TeacherLesson[];
      topics: Array<{ id: string; title: string; titleAr: string; lessons: TeacherLesson[] }>;
    }>;
  }>;
};

export type TrackSummaryBucket = {
  attemptCount: number;
  passCount: number;
  passRate: number;
  avgPercentage: number;
  avgScore: number;
  participantCount: number;
  bestPercentage: number;
  latestPercentage: number;
};

export type QuestionReferences = {
  answers: number;
  openAttempts: number;
  gradedAttempts: number;
  fixedExamPins: number;
  randomExamPins: number;
  examPins: number;
};

export type ManagedQuestion = {
  id: string;
  quizId: string | null;
  type: "MCQ" | "TRUE_FALSE";
  prompt: string;
  promptAr: string | null;
  options: string[];
  answer: string;
  explanation: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
  schoolType: string | null;
  trackScope: string;
  references: QuestionReferences;
  mockExamPins: number;
  canDelete: boolean;
  canEditAnswerKey: boolean;
};

export type HomeworkRecord = {
  id: string;
  title: string;
  titleAr: string;
  instructions: string | null;
  deadline: string;
  maxMarks: number;
  trackScope: string;
  gradedCount?: number;
  lessonId?: string;
};

// ---------------------------------------------------------------------------
// Data hook
// ---------------------------------------------------------------------------

export function useTeacherLessons() {
  return useQuery<{ lessons: TeacherLesson[]; grouped: LessonGroupNode[] }>({
    queryKey: ["teacher-lessons"],
    queryFn: async () => {
      const r = await fetch("/api/teacher/lessons");
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as { lessons: TeacherLesson[]; grouped: LessonGroupNode[] };
    },
  });
}

/** Localized label for a session: officialCode · title. */
export function lessonLabel(lesson: TeacherLesson | null | undefined): string {
  if (!lesson) return "";
  return lesson.officialCode
    ? `${lesson.officialCode} · ${lesson.title}`
    : lesson.title;
}

// ---------------------------------------------------------------------------
// Lesson picker — canonical chain first, then legacy topic lessons
// ---------------------------------------------------------------------------

/**
 * The lesson selector every authoring dialog uses.
 *
 * A lesson is labelled `officialCode · Unit / title`, and rendered under its
 * Course → Part → Unit heading. Canonical (unit-linked) lessons and legacy
 * (topic-linked) lessons are BOTH listed — hiding one chain is how quizzes
 * historically ended up unattachable from official sessions. The badges carry
 * the two facts a teacher must not have to guess: the lesson's track scope and
 * its lifecycle state.
 */
export function LessonPicker({
  lessons,
  loading,
  value,
  onChange,
}: {
  lessons: TeacherLesson[];
  loading: boolean;
  value: string;
  onChange: (id: string) => void;
}) {
  const tr = useT();
  const byId = React.useMemo(
    () => new Map(lessons.map((l) => [l.id, l])),
    [lessons]
  );
  const groups = React.useMemo(() => {
    const byCourse = new Map<
      string,
      Map<string, Map<string, Map<string, TeacherLesson[]>>>
    >();
    for (const l of lessons) {
      if (!byCourse.has(l.course.id)) byCourse.set(l.course.id, new Map());
      const parts = byCourse.get(l.course.id)!;
      if (!parts.has(l.part.id)) parts.set(l.part.id, new Map());
      const units = parts.get(l.part.id)!;
      if (!units.has(l.unit.id)) units.set(l.unit.id, new Map());
      const buckets = units.get(l.unit.id)!;
      const key = l.topic ? `topic:${l.topic.id}` : "canonical";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(l);
    }
    return byCourse;
  }, [lessons]);

  const selected = value ? byId.get(value) ?? null : null;

  if (loading) {
    return (
      <div className="h-9 rounded-md border bg-muted/30 animate-pulse" />
    );
  }

  return (
    <div className="space-y-1.5">
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={tr("teacher.081")} />
        </SelectTrigger>
        <SelectContent>
          {Array.from(groups.entries()).map(([courseId, parts]) => {
            const courseName = lessons.find((l) => l.course.id === courseId)?.course.name;
            return (
              <SelectGroup key={courseId}>
                <SelectLabel className="font-bold text-primary">
                  {courseName}
                </SelectLabel>
                {Array.from(parts.entries()).map(([partId, units]) => {
                  const part = lessons.find((l) => l.part.id === partId)?.part;
                  return (
                    <SelectGroup key={partId}>
                      <SelectLabel className="text-xs ps-3 opacity-80">
                        {tr("teacher.178")}: {part?.title}
                      </SelectLabel>
                      {Array.from(units.entries()).map(([unitId, buckets]) => {
                        const unit = lessons.find((l) => l.unit.id === unitId)?.unit;
                        return (
                          <SelectGroup key={unitId}>
                            <SelectLabel className="text-xs ps-6 opacity-70">
                              {tr("teacher.179")}: {unit?.title}
                            </SelectLabel>
                            {Array.from(buckets.entries()).map(([key, items]) =>
                              items.map((l) => (
                                <SelectItem key={l.id} value={l.id} className="text-xs">
                                  {lessonLabel(l)}
                                  {" · "}
                                  {l.archived
                                    ? tr("admin.321")
                                    : l.status === "PUBLISHED"
                                      ? tr("admin.345")
                                      : l.status === "READY"
                                        ? tr("admin.344")
                                        : tr("admin.343")}
                                </SelectItem>
                              ))
                            )}
                          </SelectGroup>
                        );
                      })}
                    </SelectGroup>
                  );
                })}
              </SelectGroup>
            );
          })}
        </SelectContent>
      </Select>

      {selected && <LessonMeta lesson={selected} />}
    </div>
  );
}

/** The provenance strip shown under a picked lesson. */
export function LessonMeta({ lesson }: { lesson: TeacherLesson }) {
  const tr = useT();
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-muted/30 p-2 text-[11px]">
      {lesson.officialCode && (
        <Badge variant="outline" className="font-mono" dir="ltr">
          {lesson.officialCode}
        </Badge>
      )}
      <TrackScopeBadge scope={lesson.trackScope} />
      {lesson.archived ? (
        <CurriculumBadge value="ARCHIVED" />
      ) : (
        <StatusBadge status={lesson.status} />
      )}
      <span className="text-muted-foreground">
        {lesson.part.title} · {lesson.unit.title}
      </span>
      {lesson.topic && (
        <span className="text-muted-foreground">· {lesson.topic.title}</span>
      )}
      <span className="ms-auto text-muted-foreground">{lesson.course.name}</span>
      <span className="sr-only" dir="ltr">
        {tr("teacher.177")}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Track scope select
// ---------------------------------------------------------------------------

/**
 * Radix Select refuses an empty string as an item value, so "inherit" travels
 * as an explicit sentinel and is translated back to "" (the API's "absent")
 * at the request boundary.
 */
export const TRACK_INHERIT = "__inherit__";

export function TrackScopeSelect({
  value,
  onChange,
  disabled = false,
  inheritLabelKey = "teacher.174",
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  inheritLabelKey?: string;
}) {
  const tr = useT();
  return (
    <Select
      value={value || TRACK_INHERIT}
      onValueChange={(v) => onChange(v === TRACK_INHERIT ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={TRACK_INHERIT}>{tr(inheritLabelKey)}</SelectItem>
        {(["SHARED", "ARABIC", "LANGUAGE"] as const).map((v) => (
          <SelectItem key={v} value={v}>
            {v === "SHARED"
              ? tr("admin.349")
              : v === "ARABIC"
                ? tr("admin.350")
                : tr("admin.351")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Homework create / edit dialog
// ---------------------------------------------------------------------------

function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/**
 * Create (no `homework`) or edit one assignment.
 *
 * On edit the lesson is fixed — the server refuses a move (api.241) — and the
 * track scope control is disabled once the assignment carries grades, because
 * changing the audience of graded work is refused too (api.239). The dialog
 * does not try to predict the rest: the server validates every field and the
 * refusal is toasted verbatim.
 */
export function HomeworkDialog({
  open,
  onOpenChange,
  lessons,
  lessonsLoading,
  homework = null,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  lessons: TeacherLesson[];
  lessonsLoading: boolean;
  homework?: HomeworkRecord | null;
}) {
  const tr = useT();
  const queryClient = useQueryClient();
  const editing = !!homework;

  const [lessonId, setLessonId] = React.useState(homework?.lessonId ?? "");
  const [title, setTitle] = React.useState(homework?.title ?? "");
  const [titleAr, setTitleAr] = React.useState(homework?.titleAr ?? "");
  const [instructions, setInstructions] = React.useState(
    homework?.instructions ?? ""
  );
  const [deadline, setDeadline] = React.useState(toLocalInput(homework?.deadline));
  const [maxMarks, setMaxMarks] = React.useState(homework?.maxMarks ?? 10);
  const [trackScope, setTrackScope] = React.useState("");

  // Phase 18 — no re-seed effect: the dashboard mounts a fresh dialog per target
  // (`key={homework?.id ?? "new"}`), so editing a different homework remounts
  // this component and the initial state above is the seeded state. Deriving on
  // mount instead of syncing in an effect avoids a cascading render and keeps
  // the "edit my draft" path a pure function of the props.

  const selectedLesson = lessons.find((l) => l.id === (homework?.lessonId ?? lessonId)) ?? null;
  const gradedCount = homework?.gradedCount ?? 0;

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        title: title.trim(),
        titleAr: titleAr.trim() || undefined,
        instructions: instructions.trim(),
        deadline: deadline ? new Date(deadline).toISOString() : "",
        maxMarks: Number(maxMarks),
      };
      if (trackScope) payload.trackScope = trackScope;
      const url = editing
        ? `/api/teacher/homework/${homework!.id}`
        : "/api/teacher/homework";
      const r = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          editing ? payload : { ...payload, lessonId }
        ),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.187"));
      queryClient.invalidateQueries({ queryKey: ["teacher-homework"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message || tr("teacher.030")),
  });

  const submit = () => {
    if (!editing && !lessonId) return toast.error(tr("teacher.188"));
    if (!title.trim()) return toast.error(tr("teacher.189"));
    if (!instructions.trim()) return toast.error(tr("teacher.190"));
    if (!deadline) return toast.error(tr("teacher.191"));
    mutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? tr("teacher.183") : tr("teacher.182")}</DialogTitle>
          <DialogDescription>
            {editing && homework ? homework.title : tr("teacher.184")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-1">
          {!editing && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {tr("teacher.081")} <span className="text-destructive">*</span>
              </Label>
              <LessonPicker
                lessons={lessons}
                loading={lessonsLoading}
                value={lessonId}
                onChange={setLessonId}
              />
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Title (EN)</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.082")}</Label>
              <Input
                value={titleAr}
                onChange={(e) => setTitleAr(e.target.value)}
                dir="rtl"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{tr("teacher.184")}</Label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={3}
            />
          </div>

          <div className="grid sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.185")}</Label>
              <Input
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.186")}</Label>
              <Input
                type="number"
                min={1}
                max={100}
                value={maxMarks}
                onChange={(e) => setMaxMarks(Number(e.target.value) || 1)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{tr("teacher.173")}</Label>
              <TrackScopeSelect
                value={trackScope}
                onChange={setTrackScope}
                disabled={editing && gradedCount > 0}
              />
            </div>
          </div>

          {selectedLesson && !editing && <LessonMeta lesson={selectedLesson} />}
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? (
              <>
                <RefreshCw className="w-4 h-4 ms-2 animate-spin" />
                {tr("teacher.051")}
              </>
            ) : (
              <>
                <Save className="w-4 h-4 ms-2" />
                {tr("teacher.089")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Question management dialog
// ---------------------------------------------------------------------------

type QuizDetail = {
  quiz: {
    id: string;
    title: string;
    titleAr: string;
    trackScope: string;
    timeLimit: number | null;
    passMark: number;
  };
  questions: ManagedQuestion[];
  attempts: { total: number; open: number; finished: number };
};

/**
 * Question management for ONE quiz.
 *
 * `canDelete` / `canEditAnswerKey` come from the server per question: a
 * question referenced by a frozen attempt cannot have its answer key edited,
 * and a question referenced by an attempt or pinned to a FIXED mock exam
 * cannot be deleted. The UI disables the control and explains WHY via the
 * server's own counters — it never guesses, and it never hides the reason.
 */
export function QuestionManagerDialog({
  quizId,
  quizTitle,
  open,
  onOpenChange,
}: {
  quizId: string;
  quizTitle: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const tr = useT();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);

  const detail = useQuery<QuizDetail>({
    queryKey: ["teacher-quiz-detail", quizId],
    enabled: open,
    queryFn: async () => {
      const r = await fetch(`/api/teacher/quizzes/${quizId}`);
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return (await r.json()) as QuizDetail;
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["teacher-quiz-detail", quizId] });
    queryClient.invalidateQueries({ queryKey: ["teacher-quizzes"] });
  };

  const deleteMutation = useMutation({
    mutationFn: async (questionId: string) => {
      const r = await fetch(`/api/teacher/questions/${questionId}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.199"));
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message || tr("teacher.030")),
  });

  const questions = detail.data?.questions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("teacher.192")}</DialogTitle>
          <DialogDescription className="flex items-center gap-2 flex-wrap">
            {quizTitle}
            {detail.data && <TrackScopeBadge scope={detail.data.quiz.trackScope} />}
            {detail.data && detail.data.quiz.timeLimit ? (
              <Badge variant="outline" dir="ltr">
                {tr("teacher.175")}: {detail.data.quiz.timeLimit}
              </Badge>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        {detail.isLoading ? (
          <div className="h-24 rounded-lg border bg-muted/30 animate-pulse" />
        ) : detail.isError ? (
          <p className="text-sm text-destructive">
            {(detail.error as Error).message}
          </p>
        ) : (
          <div className="space-y-2">
            {questions.length === 0 && (
              <p className="py-4 text-center text-sm text-muted-foreground">
                {tr("teacher.193")}
              </p>
            )}
            {questions.map((q, idx) => (
              <QuestionRow
                key={q.id}
                index={idx}
                question={q}
                editing={editingId === q.id}
                onEdit={() => setEditingId(editingId === q.id ? null : q.id)}
                onDelete={() => deleteMutation.mutate(q.id)}
                deleting={deleteMutation.isPending}
                onSaved={() => {
                  setEditingId(null);
                  invalidate();
                }}
              />
            ))}
          </div>
        )}

        <DialogFooter className="flex-row justify-between gap-2 sm:justify-between">
          <Button variant="outline" onClick={() => setAdding((v) => !v)}>
            <Plus className="w-4 h-4 ms-1.5" />
            {tr("teacher.202")}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tr("teacher.168")}
          </Button>
        </DialogFooter>

        {adding && (
          <QuestionForm
            quizId={quizId}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              invalidate();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function QuestionRow({
  index,
  question,
  editing,
  onEdit,
  onDelete,
  deleting,
  onSaved,
}: {
  index: number;
  question: ManagedQuestion;
  editing: boolean;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
  onSaved: () => void;
}) {
  const tr = useT();
  const blockers: string[] = [];
  if (question.references.gradedAttempts > 0)
    blockers.push(`${question.references.gradedAttempts} graded`);
  if (question.references.openAttempts > 0)
    blockers.push(`${question.references.openAttempts} open`);
  if (question.references.fixedExamPins > 0)
    blockers.push(`${question.references.fixedExamPins} FIXED pin(s)`);

  return (
    <div className="rounded-xl border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="secondary" className="text-[10px]">
              {tr("teacher.090")}
              {index + 1}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {question.type}
            </Badge>
            <TrackScopeBadge scope={question.trackScope} />
            <span className="text-[10px] text-muted-foreground" dir="ltr">
              {question.marks} {tr("teacher.070")} · {question.difficulty}
            </span>
            {!question.canEditAnswerKey && (
              <Badge variant="outline" className="text-[10px] bg-amber-500/15">
                {tr("teacher.198")}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm font-medium truncate">{question.prompt}</p>
          {question.promptAr && (
            <p className="text-xs text-muted-foreground truncate" dir="rtl">
              {question.promptAr}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="text-xs" onClick={onEdit}>
            {tr("teacher.194")}
          </Button>
          {question.canDelete ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={deleting}
              onClick={onDelete}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <TooltipProviderLite label={`${tr("teacher.196")} — ${blockers.join(", ")}`}>
              <Button variant="ghost" size="sm" disabled className="opacity-40">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </TooltipProviderLite>
          )}
        </div>
      </div>

      {editing && (
        <QuestionForm
          quizId={question.quizId ?? ""}
          question={question}
          onCancel={onEdit}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

function TooltipProviderLite({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>{children}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Create (`question` absent) or edit (`question` present) one question.
 *
 * The answer-key inputs are disabled when the server reported the question is
 * locked (`canEditAnswerKey === false`) — the server refuses those edits with a
 * 409 regardless, so the UI simply does not offer an action it knows will fail.
 */
export function QuestionForm({
  quizId,
  question = null,
  onCancel,
  onSaved,
}: {
  quizId: string;
  question?: ManagedQuestion | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const tr = useT();
  const editing = !!question;
  const [type, setType] = React.useState<"MCQ" | "TRUE_FALSE">(question?.type ?? "MCQ");
  const [prompt, setPrompt] = React.useState(question?.prompt ?? "");
  const [promptAr, setPromptAr] = React.useState(question?.promptAr ?? "");
  const [options, setOptions] = React.useState<string[]>(
    question?.options?.length ? question.options : ["", "", "", ""]
  );
  const [answer, setAnswer] = React.useState(question?.answer ?? "0");
  const [explanation, setExplanation] = React.useState(question?.explanation ?? "");
  const [difficulty, setDifficulty] = React.useState<"EASY" | "MEDIUM" | "HARD">(
    question?.difficulty ?? "MEDIUM"
  );
  const [marks, setMarks] = React.useState(question?.marks ?? 1);
  const [schoolType, setSchoolType] = React.useState(question?.trackScope ?? "");
  const answerKeyLocked = editing && question!.canEditAnswerKey === false;

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        type,
        prompt: prompt.trim(),
        promptAr: promptAr.trim() || null,
        explanation: explanation.trim() || null,
        difficulty,
      };
      if (!answerKeyLocked) {
        payload.options = options.map((o) => o.trim()).filter((o) => o !== "");
        payload.answer = type === "TRUE_FALSE" ? answer : String(answer);
        payload.marks = Number(marks);
      }
      if (schoolType) payload.schoolType = schoolType;
      const url = editing
        ? `/api/teacher/questions/${question!.id}`
        : `/api/teacher/quizzes/${quizId}/questions`;
      const r = await fetch(url, {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.204"));
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message || tr("teacher.030")),
  });

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 space-y-3">
      <div className="grid sm:grid-cols-3 gap-2">
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">{tr("teacher.091")}</Label>
          <Select
            value={type}
            onValueChange={(v) => setType(v as "MCQ" | "TRUE_FALSE")}
            disabled={answerKeyLocked}
          >
            <SelectTrigger size="sm" className="w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MCQ">{tr("teacher.091")}</SelectItem>
              <SelectItem value="TRUE_FALSE">{tr("teacher.092")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">Marks</Label>
          <Input
            type="number"
            min={1}
            max={100}
            value={marks}
            disabled={answerKeyLocked}
            onChange={(e) => setMarks(Number(e.target.value) || 1)}
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">{tr("teacher.203")}</Label>
          <TrackScopeSelect value={schoolType} onChange={setSchoolType} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">{tr("teacher.094")}</Label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          className="text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">{tr("teacher.095")}</Label>
        <Textarea
          value={promptAr}
          onChange={(e) => setPromptAr(e.target.value)}
          rows={2}
          dir="rtl"
          className="text-sm"
        />
      </div>

      {type === "MCQ" ? (
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">{tr("teacher.097")}</Label>
          {options.map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <button
                type="button"
                disabled={answerKeyLocked}
                onClick={() => setAnswer(String(i))}
                className={`w-5 h-5 rounded-full border-2 shrink-0 ${
                  answer === String(i)
                    ? "border-primary bg-primary"
                    : "border-input"
                }`}
                aria-label={tr("teacher.098", { p1: i + 1 })}
              />
              <Input
                value={opt}
                disabled={answerKeyLocked}
                onChange={(e) =>
                  setOptions(options.map((o, j) => (j === i ? e.target.value : o)))
                }
                className="h-8 text-sm"
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">{tr("teacher.102")}</Label>
          <div className="flex items-center gap-2">
            <Button
              variant={answer === "0" ? "default" : "outline"}
              size="sm"
              disabled={answerKeyLocked}
              onClick={() => setAnswer("0")}
              type="button"
            >
              True
            </Button>
            <Button
              variant={answer === "1" ? "default" : "outline"}
              size="sm"
              disabled={answerKeyLocked}
              onClick={() => setAnswer("1")}
              type="button"
            >
              False
            </Button>
          </div>
        </div>
      )}

      {answerKeyLocked && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
          {tr("teacher.198")}
        </p>
      )}

      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">{tr("teacher.106")}</Label>
        <Textarea
          value={explanation}
          onChange={(e) => setExplanation(e.target.value)}
          rows={2}
          className="text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
          {mutation.isPending ? (
            <RefreshCw className="w-3.5 h-3.5 ms-1.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5 ms-1.5" />
          )}
          {tr("teacher.167")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {tr("teacher.168")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Track split (minimal analytics addition)
// ---------------------------------------------------------------------------

/**
 * The Phase 18 track split of Phase 6's finished-attempt summary.
 *
 * Renders ONLY the three buckets the server computed; it never recomputes a
 * percentage from other numbers, so what the teacher reads here is exactly
 * what the API returned.
 */
export function TrackSplitRow({
  split,
}: {
  split: Record<string, TrackSummaryBucket> | undefined;
}) {
  const tr = useT();
  if (!split) return null;
  const buckets: Array<["SHARED" | "ARABIC" | "LANGUAGE"]> = [
    ["SHARED"],
    ["ARABIC"],
    ["LANGUAGE"],
  ];
  return (
    <div className="mt-2 rounded-lg border bg-muted/20 p-2">
      <div className="text-[10px] text-muted-foreground mb-1">
        {tr("teacher.201")}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        {buckets.map(([key]) => {
          const b = split[key];
          return (
            <div key={key} className="space-y-0.5">
              <TrackScopeBadge scope={key} />
              <div className="text-[11px] font-bold">
                {b ? `${b.avgPercentage}%` : "—"}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {b ? `${b.attemptCount} ${tr("teacher.067")}` : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
