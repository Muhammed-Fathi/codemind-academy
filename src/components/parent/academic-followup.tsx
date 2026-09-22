"use client";

// ============================================================
// CodeMind Academy — Phase I: Parent Academic Follow-up
//
// Arabic-first RTL. Answers three questions in this order:
//   1. "إيه اللي حصل؟"            → the situation header + progress
//   2. "هل فيه حاجة محتاجة تدخل؟" → Action Needed (blocking first)
//   3. "الطالب محتاج يعمل إيه دلوقتي؟" → the current lesson's unmet requirements
//
// DESIGN RULES
//   * EVERY number and every status here comes from
//     `GET /api/parents/me/academics`, which is assembled from the Phase F/G/H
//     authorities. This component computes NOTHING academic: no completion, no
//     pass/fail, no hold, no deadline verdict is derived on the client.
//   * No raw enums and no database ids are rendered. Lesson states arrive as
//     LOCKED / UNLOCKED / COMPLETED with a canonical Arabic label, absence
//     states as their own Arabic labels, and lock reasons as the canonical
//     Arabic reason string produced by the Phase H engine.
//   * No green "success" visuals for an incomplete requirement: a pending
//     requirement is amber, a blocking one is red, and only a genuinely
//     satisfied one is green.
//   * Unpublished / hidden content is never named. If a lesson is locked, the
//     card says WHY (canonical reason) — it never previews what is behind it.
// ============================================================

import * as React from "react";
import { useT } from "@/lib/i18n";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  BookOpen,
  CalendarClock,
  CalendarX,
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  ClipboardList,
  GraduationCap,
  Lock,
  MessageSquareQuote,
  RefreshCw,
  ShieldAlert,
  Video,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

export type AcademicsChild = {
  id: string;
  name: string;
  courseName: string | null;
  avatarUrl: string | null;
};

type RequirementView = {
  required: boolean;
  done: boolean;
  value: number;
  requiredCount?: number;
  completedCount?: number;
};

type LessonView = {
  code: string | null;
  title: string;
  position: number;
  state: "LOCKED" | "UNLOCKED" | "COMPLETED";
  unlocked: boolean;
  completed: boolean;
  reason: string | null;
  reasonCode: string | null;
  unmet: { kind: string; label: string }[];
  requirements: {
    video: RequirementView | null;
    quiz: RequirementView | null;
    homework: RequirementView | null;
  };
  overrideGranted: boolean;
};

type HomeworkView = {
  title: string;
  lessonTitle: string | null;
  acceptingSubmissions: boolean;
  dueAt: string | null;
  status: "NOT_SUBMITTED_YET" | "MISSING_OVERDUE" | "SUBMITTED" | "SUBMITTED_LATE" | "GRADED";
  submittedAt: string | null;
  late: boolean;
  grade: number | null;
  maxMarks: number | null;
  feedback: string | null;
};

type QuizView = {
  title: string;
  lessonTitle: string | null;
  attempts: number;
  lastOutcome: "PASSED" | "FAILED" | null;
  lastPercentage: number | null;
  bestPercentage: number | null;
  lastCompletedAt: string | null;
};

type AbsenceView = {
  sessionTitle: string;
  sessionStartAt: string;
  status: string;
  reason: string | null;
  holdActive: boolean;
  decidedAt: string | null;
  decisionNote: string | null;
};

type HoldView = {
  lessonTitle: string | null;
  inUniverse: boolean;
  reason: string | null;
  unmet: { kind: string; label: string }[];
  eligible: boolean;
};

type SessionView = {
  title: string;
  lessonTitle: string | null;
  startAt: string;
  endsAt: string;
  status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  teacherName: string | null;
  rescheduled: boolean;
  originalStartAt: string | null;
  rescheduleCount: number;
  cancelledAt: string | null;
  cancelReason: string | null;
};

type ActionItem = {
  code: string;
  severity: "blocking" | "attention";
  label: string;
  detail: string | null;
};

export type AcademicsSnapshot = {
  student: {
    id: string;
    name: string;
    grade: string | null;
    schoolType: string | null;
    studentCode: string | null;
    avatarUrl: string | null;
  };
  course: { name: string; track: string | null } | null;
  group: { name: string; schedule: string | null } | null;
  progress: {
    completedLessons: number;
    totalLessons: number;
    pct: number;
    currentLesson: LessonView | null;
    lockedLessons: number;
  };
  lessons: LessonView[];
  holds: HoldView[];
  absences: {
    excused: number;
    unexcused: number;
    pending: number;
    recent: AbsenceView[];
  };
  homework: {
    submitted: number;
    graded: number;
    overdue: number;
    items: HomeworkView[];
  };
  quizzes: { taken: number; passed: number; items: QuizView[] };
  sessions: {
    upcoming: SessionView[];
    rescheduled: SessionView[];
    cancelled: SessionView[];
  };
  teacherFeedback: {
    source: "HOMEWORK" | "TEACHER_NOTE";
    title: string | null;
    note: string;
    authorName: string | null;
    at: string;
  }[];
  actionNeeded: ActionItem[];
  evaluatedAt: string;
};

export type AcademicsPayload = {
  selectedStudentId: string;
  children: AcademicsChild[];
  snapshot: AcademicsSnapshot;
};

// ---------- formatting ----------
const curLocale = () =>
  typeof window === "undefined"
    ? "ar"
    : document.documentElement.lang === "en"
      ? "en"
      : "ar";
const dtLocale = () => (curLocale() === "en" ? "en-GB" : "ar-EG");
function fmtDate(value: string | Date | null): string {
  if (!value) return "";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(dtLocale(), {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EmptyMini({ text }: { text: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>;
}

// ---------- Action Needed ----------
function ActionNeededCard({ items }: { items: ActionItem[] }) {
  const t = useT();
  const blocking = items.filter((i) => i.severity === "blocking");
  const attention = items.filter((i) => i.severity === "attention");

  return (
    <Card className={blocking.length > 0 ? "border-destructive/40" : ""}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert
            className={`h-4 w-4 ${blocking.length > 0 ? "text-destructive" : "text-emerald-600"}`}
          />
          {t("parent.followup.actionNeeded")}
        </CardTitle>
        <CardDescription>
          {blocking.length === 0 && attention.length === 0
            ? t("parent.followup.allClear")
            : t("parent.followup.nextStep")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            <span>{t("parent.followup.allClear")}</span>
          </div>
        ) : (
          [...blocking, ...attention].map((item, index) => {
            const isBlocking = item.severity === "blocking";
            return (
              <div
                key={`${item.code}-${index}`}
                className={[
                  "flex items-start gap-2 rounded-lg border p-3 text-sm",
                  isBlocking
                    ? "border-destructive/40 bg-destructive/5"
                    : "border-amber-500/30 bg-amber-500/5",
                ].join(" ")}
              >
                {isBlocking ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                ) : (
                  <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                )}
                <div className="min-w-0">
                  <p className="font-semibold leading-snug">{item.label}</p>
                  {item.detail ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Situation header ----------
function SituationHeader({ snapshot }: { snapshot: AcademicsSnapshot }) {
  const t = useT();
  const { progress, course, group } = snapshot;
  const current = progress.currentLesson;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{t("parent.followup.title")}</CardTitle>
            <CardDescription className="mt-1">
              {course ? (
                <>
                  {t("parent.followup.subtitle")} ·{" "}
                  <GraduationCap className="inline h-3.5 w-3.5 ms-1 align-[-2px]" />
                  {course.name}
                  {group?.name ? ` · ${group.name}` : ""}
                </>
              ) : (
                t("parent.followup.noCourse")
              )}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">
              {t("parent.progress.lessonsDone", {
                p1: progress.completedLessons,
                p2: progress.totalLessons,
              })}
            </Badge>
            {progress.lockedLessons > 0 ? (
              <Badge variant="outline" className="gap-1">
                <Lock className="h-3 w-3" />
                {t("parent.progress.lockedCount", { p1: progress.lockedLessons })}
              </Badge>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {progress.totalLessons > 0 ? (
          <div className="space-y-1.5">
            <Progress value={Math.max(0, Math.min(100, progress.pct))} className="h-2" />
            <p className="text-xs text-muted-foreground">
              {t("parent.progress.completedCount", { p1: progress.completedLessons })} ·{" "}
              {progress.pct}%
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("parent.progress.noLessons")}</p>
        )}

        {current ? (
          <div
            className={[
              "rounded-lg border p-3",
              current.unlocked
                ? "border-primary/30 bg-primary/5"
                : "border-amber-500/30 bg-amber-500/5",
            ].join(" ")}
          >
            <p className="text-xs font-semibold text-muted-foreground">
              {t("parent.progress.currentLesson")}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-bold">
              {current.code ? (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">
                  {current.code}
                </span>
              ) : null}
              {current.title}
            </p>
            {current.reason ? (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {current.reason}
              </p>
            ) : null}
            {current.unmet.length > 0 ? (
              <ul className="mt-2 space-y-1">
                {current.unmet.map((entry) => (
                  <li key={entry.kind} className="flex items-center gap-1.5 text-xs">
                    <CircleDashed className="h-3 w-3 shrink-0 text-amber-600" />
                    {entry.label}
                  </li>
                ))}
              </ul>
            ) : null}
            {current.overrideGranted ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {t("parent.requirement.override")}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------- Lessons ----------
function stateTone(state: LessonView["state"]): string {
  if (state === "COMPLETED") return "border-emerald-500/30 bg-emerald-500/5";
  if (state === "UNLOCKED") return "border-primary/30 bg-primary/5";
  return "border-border bg-muted/30";
}

function LessonRow({ lesson }: { lesson: LessonView }) {
  const t = useT();
  const stateLabel =
    lesson.state === "COMPLETED"
      ? t("parent.state.COMPLETED")
      : lesson.state === "UNLOCKED"
        ? t("parent.state.UNLOCKED")
        : t("parent.state.LOCKED");

  const chips: React.ReactNode[] = [];
  const { video, quiz, homework } = lesson.requirements;
  if (video?.required) {
    chips.push(
      <span key="video" className="inline-flex items-center gap-1">
        <Video className="h-3 w-3" />
        {t("parent.requirement.video")}
        {video.done ? "" : ` — ${t("parent.requirement.videoPercent", { p1: video.value })}`}
        {video.done ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        ) : (
          <CircleDashed className="h-3 w-3 text-amber-600" />
        )}
      </span>
    );
  }
  if (quiz?.required) {
    chips.push(
      <span key="quiz" className="inline-flex items-center gap-1">
        <ClipboardCheck className="h-3 w-3" />
        {t("parent.requirement.quiz")}
        {quiz.done ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        ) : (
          <CircleDashed className="h-3 w-3 text-amber-600" />
        )}
      </span>
    );
  }
  if (homework?.required) {
    chips.push(
      <span key="homework" className="inline-flex items-center gap-1">
        <ClipboardList className="h-3 w-3" />
        {t("parent.requirement.homework")}
        {homework.done ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
        ) : (
          <CircleDashed className="h-3 w-3 text-amber-600" />
        )}
      </span>
    );
  }

  return (
    <div className={`flex items-start gap-3 rounded-lg border p-3 ${stateTone(lesson.state)}`}>
      <span className="mt-0.5 w-6 shrink-0 text-center text-xs font-bold text-muted-foreground">
        {lesson.position}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {lesson.code ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono">
              {lesson.code}
            </span>
          ) : null}
          <span className="truncate text-sm font-semibold">{lesson.title}</span>
          <Badge
            variant={
              lesson.state === "COMPLETED"
                ? "secondary"
                : lesson.state === "UNLOCKED"
                  ? "outline"
                  : "outline"
            }
            className="text-[10px]"
          >
            {stateLabel}
          </Badge>
        </div>
        {lesson.reason ? (
          <p className="mt-1 text-xs text-muted-foreground">{lesson.reason}</p>
        ) : null}
        {chips.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {chips}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LessonsCard({ lessons }: { lessons: LessonView[] }) {
  const t = useT();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4" />
          {t("parent.progress.title")}
        </CardTitle>
        <CardDescription>{t("parent.progress.lockedNote")}</CardDescription>
      </CardHeader>
      <CardContent>
        {lessons.length === 0 ? (
          <EmptyMini text={t("parent.progress.noLessons")} />
        ) : (
          <div className="max-h-[22rem] space-y-2 overflow-y-auto pe-1">
            {lessons.map((lesson) => (
              <LessonRow key={`${lesson.position}-${lesson.title}`} lesson={lesson} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Absences / holds ----------
function absenceLabel(t: (k: string) => string, status: string): string {
  switch (String(status ?? "").toUpperCase()) {
    case "EXCUSED":
      return t("parent.absence.excused");
    case "UNEXCUSED":
      return t("parent.absence.unexcused");
    case "PENDING_REVIEW":
      return t("parent.absence.pendingUnderReview");
    case "PENDING_REASON":
      return t("parent.absence.pendingReason");
    default:
      return t("absence.status.noAction");
  }
}

function AbsencesCard({
  absences,
  holds,
}: {
  absences: AcademicsSnapshot["absences"];
  holds: HoldView[];
}) {
  const t = useT();
  const hasRows = absences.recent.length > 0 || holds.length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarX className="h-4 w-4" />
          {t("parent.followup.absences")}
        </CardTitle>
        <CardDescription>
          {t("parent.absences.readOnlyNotice")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary" className="gap-1">
            {t("parent.absence.excused")}: {absences.excused}
          </Badge>
          <Badge
            variant={absences.unexcused > 0 ? "destructive" : "outline"}
            className="gap-1"
          >
            {t("parent.absence.unexcused")}: {absences.unexcused}
          </Badge>
          {absences.pending > 0 ? (
            <Badge variant="outline" className="gap-1">
              {t("parent.absence.pendingUnderReview")}: {absences.pending}
            </Badge>
          ) : null}
        </div>

        {holds.length > 0 ? (
          <div className="space-y-2">
            {holds.map((hold, index) => (
              <div
                key={`hold-${index}`}
                className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
              >
                <p className="flex items-center gap-1.5 font-semibold">
                  <ShieldAlert className="h-4 w-4 shrink-0 text-destructive" />
                  {t("parent.hold.title")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {hold.lessonTitle ? `${t("parent.progress.currentLesson")}: ${hold.lessonTitle}` : null}
                </p>
                <p className="mt-1 text-xs">{t("parent.hold.subtitle")}</p>
                {hold.eligible ? (
                  <p className="mt-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                    {t("parent.action.catchupNow")}
                  </p>
                ) : hold.inUniverse && hold.reason ? (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                    {hold.reason}
                  </p>
                ) : null}
                {hold.unmet.length > 0 ? (
                  <ul className="mt-1.5 space-y-1">
                    {hold.unmet.map((entry) => (
                      <li key={entry.kind} className="flex items-center gap-1.5 text-xs">
                        <CircleDashed className="h-3 w-3 shrink-0 text-amber-600" />
                        {entry.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {!hasRows ? (
          <EmptyMini text={t("parent.absence.empty")} />
        ) : (
          <div className="space-y-2">
            {absences.recent.map((item, index) => (
              <div key={`absence-${index}`} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-semibold">{item.sessionTitle}</p>
                  <Badge
                    variant={
                      item.status === "UNEXCUSED"
                        ? "destructive"
                        : item.status === "EXCUSED"
                          ? "secondary"
                          : "outline"
                    }
                    className="text-[10px]"
                  >
                    {absenceLabel(t, item.status)}
                  </Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {fmtDate(item.sessionStartAt)}
                </p>
                {item.reason ? (
                  <p className="mt-1 text-xs">
                    <span className="text-muted-foreground">{t("absence.reason")}: </span>
                    {item.reason}
                  </p>
                ) : null}
                {item.decisionNote ? (
                  <p className="mt-1 text-xs">
                    <span className="text-muted-foreground">
                      {t("parent.absence.decisionNote")}:{" "}
                    </span>
                    {item.decisionNote}
                  </p>
                ) : null}
                {item.holdActive ? (
                  <p className="mt-1 text-[11px] font-semibold text-destructive">
                    {t("parent.absence.holdActive")}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Homework ----------
function homeworkLabel(t: (k: string) => string, status: HomeworkView["status"]): string {
  switch (status) {
    case "NOT_SUBMITTED_YET":
      return t("parent.hw.notSubmittedYet");
    case "MISSING_OVERDUE":
      return t("parent.hw.missingOverdue");
    case "SUBMITTED":
      return t("parent.hw.submitted");
    case "SUBMITTED_LATE":
      return t("parent.hw.submittedLate");
    case "GRADED":
      return t("parent.hw.graded");
  }
}

function homeworkTone(status: HomeworkView["status"]): string {
  if (status === "MISSING_OVERDUE") return "border-destructive/40 bg-destructive/5";
  if (status === "GRADED" || status === "SUBMITTED") return "border-emerald-500/30 bg-emerald-500/5";
  if (status === "SUBMITTED_LATE") return "border-amber-500/30 bg-amber-500/5";
  return "border-border bg-muted/30";
}

function HomeworkCard({
  homework,
}: {
  homework: AcademicsSnapshot["homework"];
}) {
  const t = useT();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4" />
          {t("parent.hw.title")}
        </CardTitle>
        <CardDescription>
          {t("parent.progress.lessonsDone", {
            p1: homework.submitted,
            p2: homework.items.length,
          })}
          {homework.overdue > 0 ? ` · ${t("parent.hw.missingOverdue")}: ${homework.overdue}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {homework.items.length === 0 ? (
          <EmptyMini text={t("parent.hw.empty")} />
        ) : (
          <div className="space-y-2">
            {homework.items.map((item, index) => (
              <div key={`hw-${index}`} className={`rounded-lg border p-3 ${homeworkTone(item.status)}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{item.title}</p>
                    {item.lessonTitle ? (
                      <p className="text-[11px] text-muted-foreground">{item.lessonTitle}</p>
                    ) : null}
                  </div>
                  <Badge
                    variant={
                      item.status === "MISSING_OVERDUE"
                        ? "destructive"
                        : item.status === "GRADED" || item.status === "SUBMITTED"
                          ? "secondary"
                          : "outline"
                    }
                    className="text-[10px]"
                  >
                    {homeworkLabel(t, item.status)}
                  </Badge>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>
                    {t("parent.hw.due")}: {fmtDate(item.dueAt)}
                  </span>
                  {item.submittedAt ? <span>{fmtDate(item.submittedAt)}</span> : null}
                  {item.status === "GRADED" && item.grade !== null ? (
                    <span className="font-semibold text-foreground">
                      {t("parent.hw.grade")}: {item.grade}
                      {item.maxMarks !== null ? `/${item.maxMarks}` : ""}
                    </span>
                  ) : null}
                  {!item.acceptingSubmissions ? (
                    <span>{t("parent.hw.closedForSubmission")}</span>
                  ) : null}
                </div>
                {item.feedback ? (
                  <p className="mt-2 rounded bg-muted/60 p-2 text-xs">
                    <MessageSquareQuote className="inline h-3 w-3 ms-1 align-[-2px]" />
                    <span className="font-semibold">{t("parent.hw.feedback")}: </span>
                    {item.feedback}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Quizzes (summary only) ----------
function QuizCard({ quizzes }: { quizzes: AcademicsSnapshot["quizzes"] }) {
  const t = useT();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="h-4 w-4" />
          {t("parent.quiz.title")}
        </CardTitle>
        <CardDescription>{t("parent.quiz.privacy")}</CardDescription>
      </CardHeader>
      <CardContent>
        {quizzes.items.length === 0 ? (
          <EmptyMini text={t("parent.quiz.empty")} />
        ) : (
          <div className="space-y-2">
            {quizzes.items.map((item, index) => (
              <div
                key={`quiz-${index}`}
                className={[
                  "rounded-lg border p-3",
                  item.lastOutcome === "PASSED"
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : item.lastOutcome === "FAILED"
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-border bg-muted/30",
                ].join(" ")}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{item.title}</p>
                    {item.lessonTitle ? (
                      <p className="text-[11px] text-muted-foreground">{item.lessonTitle}</p>
                    ) : null}
                  </div>
                  <Badge
                    variant={
                      item.lastOutcome === "PASSED"
                        ? "secondary"
                        : item.lastOutcome === "FAILED"
                          ? "destructive"
                          : "outline"
                    }
                    className="text-[10px]"
                  >
                    {item.lastOutcome === "PASSED"
                      ? t("parent.quiz.passed")
                      : item.lastOutcome === "FAILED"
                        ? t("parent.quiz.failed")
                        : t("parent.quiz.notTaken")}
                  </Badge>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{t("parent.quiz.attempts", { p1: item.attempts })}</span>
                  {item.lastPercentage !== null ? (
                    <span>
                      {t("parent.quiz.lastAt")}: {item.lastPercentage}%
                    </span>
                  ) : null}
                  {item.bestPercentage !== null && item.bestPercentage !== item.lastPercentage ? (
                    <span>
                      {t("parent.quiz.best")}: {item.bestPercentage}%
                    </span>
                  ) : null}
                  {item.lastCompletedAt ? <span>{fmtDate(item.lastCompletedAt)}</span> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Live sessions ----------
function SessionRow({
  session,
  tone,
}: {
  session: SessionView;
  tone: "upcoming" | "rescheduled" | "cancelled";
}) {
  const t = useT();
  return (
    <div
      className={[
        "rounded-lg border p-3",
        tone === "cancelled"
          ? "border-destructive/40 bg-destructive/5"
          : tone === "rescheduled"
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-border bg-muted/30",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm font-semibold">{session.title}</p>
        {session.status === "LIVE" ? (
          <Badge variant="destructive" className="text-[10px]">
            {t("live.status.live")}
          </Badge>
        ) : null}
      </div>
      <div className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
        <p>{fmtDate(session.startAt)}</p>
        {session.lessonTitle ? <p>{session.lessonTitle}</p> : null}
        {session.teacherName ? (
          <p>
            {t("parent.session.teacher")}: {session.teacherName}
          </p>
        ) : null}
        {session.rescheduled && session.originalStartAt ? (
          <p className="font-semibold text-amber-700 dark:text-amber-400">
            {t("parent.session.wasAt", { p1: fmtDate(session.originalStartAt) })}
            {session.rescheduleCount > 1 ? ` (${session.rescheduleCount})` : ""}
          </p>
        ) : null}
        {session.cancelReason ? (
          <p>
            {t("parent.session.reason")}: {session.cancelReason}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SessionsCard({ sessions }: { sessions: AcademicsSnapshot["sessions"] }) {
  const t = useT();
  const groups: Array<{
    key: "upcoming" | "rescheduled" | "cancelled";
    title: string;
    icon: React.ReactNode;
    rows: SessionView[];
    empty: string;
  }> = [
    {
      key: "upcoming",
      title: t("parent.session.upcoming"),
      icon: <CalendarClock className="h-4 w-4" />,
      rows: sessions.upcoming,
      empty: t("parent.session.empty"),
    },
    {
      key: "rescheduled",
      title: t("parent.session.rescheduled"),
      icon: <RefreshCw className="h-4 w-4" />,
      rows: sessions.rescheduled,
      empty: t("parent.session.empty"),
    },
    {
      key: "cancelled",
      title: t("parent.session.cancelled"),
      icon: <CalendarX className="h-4 w-4" />,
      rows: sessions.cancelled,
      empty: t("parent.session.empty"),
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4" />
          {t("parent.session.upcoming")}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        {groups.map((group) => (
          <div key={group.key} className="space-y-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              {group.icon}
              {group.title}
            </p>
            {group.rows.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-center text-[11px] text-muted-foreground">
                {group.empty}
              </p>
            ) : (
              group.rows.map((session, index) => (
                <SessionRow key={`${group.key}-${index}`} session={session} tone={group.key} />
              ))
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------- Teacher feedback ----------
function FeedbackCard({
  feedback,
}: {
  feedback: AcademicsSnapshot["teacherFeedback"];
}) {
  const t = useT();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageSquareQuote className="h-4 w-4" />
          {t("parent.feedback.title")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {feedback.length === 0 ? (
          <EmptyMini text={t("parent.feedback.empty")} />
        ) : (
          <div className="space-y-2">
            {feedback.map((item, index) => (
              <div key={`feedback-${index}`} className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    {item.source === "HOMEWORK"
                      ? t("parent.feedback.fromHomework")
                      : t("parent.feedback.fromTeacher")}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">{fmtDate(item.at)}</span>
                </div>
                {item.title ? (
                  <p className="mt-1 text-xs font-semibold">{item.title}</p>
                ) : null}
                <p className="mt-1 text-sm">{item.note}</p>
                {item.authorName ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">{item.authorName}</p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------- Skeleton ----------
export function AcademicFollowupSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-36 w-full" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56" />
        <Skeleton className="h-56" />
      </div>
    </div>
  );
}

// ---------- Main ----------
export function AcademicFollowup({ payload }: { payload: AcademicsPayload }) {
  const t = useT();
  const snapshot = payload.snapshot;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-4"
      dir="rtl"
    >
      {/* The three questions, in the parent's reading order:
            1. "إيه اللي حصل؟"                    → the situation header
            2. "هل فيه حاجة محتاجة تدخل؟"         → Action Needed
            3. "الطالب محتاج يعمل إيه دلوقتي؟"    → the next step inside it
          Action Needed still leads WITHIN itself (blocking before attention)
          so urgency is never buried — but the story is told in order. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SituationHeader snapshot={snapshot} />
        <LessonsCard lessons={snapshot.lessons} />
      </div>

      <ActionNeededCard items={snapshot.actionNeeded} />

      <SessionsCard sessions={snapshot.sessions} />

      <div className="grid gap-4 lg:grid-cols-2">
        <AbsencesCard absences={snapshot.absences} holds={snapshot.holds} />
        <HomeworkCard homework={snapshot.homework} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <QuizCard quizzes={snapshot.quizzes} />
        <FeedbackCard feedback={snapshot.teacherFeedback} />
      </div>

      <p className="text-center text-[11px] text-muted-foreground">
        {t("parent.followup.readOnly")} · {fmtDate(snapshot.evaluatedAt)}
      </p>
    </motion.div>
  );
}

/** The error/empty shell every parent surface shares. */
export function AcademicFollowupError({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <p className="text-sm">{t("parent.followup.loadError")}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw className="h-4 w-4 ms-2" />
          {t("parent.followup.retry")}
        </Button>
      </CardContent>
    </Card>
  );
}
