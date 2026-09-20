"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useApp } from "@/lib/store";
// Phase C representation fix — the ONE unit-summary counter (pure, shared
// with the Phase C suite): canonical Lessons vs legacy Topics, with zero
// segments impossible by construction.
import { countUnitContent } from "@/lib/unit-counts";
import { toast } from "sonner";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  Circle,
  Lock,
  PlayCircle,
  FileText,
  Trophy,
  Clock,
  Layers,
  Sparkles,
  Video,
  ClipboardList,
} from "lucide-react";

// ============================================================
// Types
// ============================================================
type LessonStatus = "completed" | "current" | "locked" | "available";

type LessonItem = {
  id: string;
  title: string;
  titleAr: string;
  order: number;
  duration: number;
  // Phase 13: the retired `Lesson.isLocked` column is no longer serialised by
  // the API, and this component never needed it — "locked" here is a
  // *progression* state computed by the server (`status`, from
  // getCourseSessionProgress), which is why the field is gone from the type.
  videoUrl: string | null;
  pdfUrl: string | null;
  summary: string | null;
  description: string | null;
  progress: number;
  isCompleted: boolean;
  status: LessonStatus;
  /** Presence only — the API never names a locked session's quiz/assignment. */
  hasQuiz?: boolean;
  hasAssignment?: boolean;
  /** Phase 16 — official session identity (1-1..7-3), part of the skeleton. */
  officialCode: string | null;
  /** Phase 16 — lock-independent presence (badges without identities/URLs). */
  hasVideo?: boolean;
  hasPdf?: boolean;
  materialCount?: number;
  /**
   * Phase C — the shared Lesson Content Summary (video / material / quiz /
   * homework states + counts). Same authority as the lesson page and the
   * dashboard; the chips below never re-derive presence locally.
   */
  content?: {
    video: { state: "ABSENT" | "AVAILABLE" | "LOCKED"; count: number };
    material: { state: "ABSENT" | "AVAILABLE" | "LOCKED"; count: number };
    quiz: { state: "ABSENT" | "AVAILABLE" | "LOCKED"; count: number };
    homework: { state: "ABSENT" | "AVAILABLE" | "LOCKED"; count: number };
  } | null;
  quiz: { id: string; title: string; titleAr: string } | null;
  homework: { id: string; title: string; titleAr: string } | null;
  /**
   * Phase H — the CANONICAL verdict for this session. A locked row carries
   * the state + the Arabic-first reason and its ordered unmet codes (and
   * nothing else: no requirement breakdown, no identity — the Phase 4/16
   * redaction contract is untouched). `reason.text` is already translated by
   * the server with the request locale, so the tree never re-derives a
   * sentence and can never disagree with what the backend enforces.
   */
  progression?: {
    state: "LOCKED" | "UNLOCKED" | "COMPLETED";
    reason: { code: string; text: string } | null;
    unmet: { code: string; text: string }[];
  } | null;
};

type TopicItem = {
  id: string;
  title: string;
  titleAr: string;
  order: number;
  lessons: LessonItem[];
};

type UnitItem = {
  id: string;
  title: string;
  titleAr: string;
  order: number;
  icon: string | null;
  /** Canonical Unit-linked sessions (Course → Part → Unit → Lesson). */
  lessons: LessonItem[];
  /** Legacy grouping, kept only so older content still renders. */
  topics: TopicItem[];
};

/**
 * Phase C representation fix — the Unit summary counts. The OLD summary
 * rendered `{unit.topics.length} Topics · {unitLessons(unit).length} Lessons`
 * unconditionally and in hardcoded English, so a purely canonical unit (the
 * official Course → Part → Unit → Lesson chain) advertised a meaningless
 * "0 Topics" beside its visibly rendered Lesson 1-1 — the QA defect. The
 * counts now come from `countUnitContent` (src/lib/unit-counts.ts), which
 * derives them from the SAME arrays the accordion below renders:
 *
 *   * "empty"                     → no summary line at all (a zero segment
 *                                   can never render);
 *   * canonical-only units        → the localized Lessons count (course.240);
 *   * real legacy Topic chains    → "Topics · Lessons" (course.241) — both
 *                                   segments backed by ≥ 1 visible row.
 *
 * A canonical Lesson is never counted as a legacy Topic, and the Lessons
 * number always equals the exact rows rendered under the Unit.
 */
function UnitCountSummary({ unit }: { unit: UnitItem }) {
  const tr = useT();
  const c = countUnitContent(unit);
  if (c.total === 0) return null;
  return (
    <div className="text-[11px] text-muted-foreground">
      {c.legacyTopics > 0
        ? tr("course.241", { p1: c.legacyTopics, p2: c.total })
        : tr("course.240", { p1: c.total })}
    </div>
  );
}

type PartItem = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  order: number;
  units: UnitItem[];
};

type CourseData = {
  course: {
    id: string;
    slug: string;
    name: string;
    nameAr: string;
    description: string;
    color: string;
  };
  parts: PartItem[];
  progress: {
    totalLessons: number;
    completedLessons: number;
    percentage: number;
  };
};

// ============================================================
// Main
// ============================================================
export function StudentCourseView() {
  const tr = useT();
  const setView = useApp((s) => s.setView);
  const navParam = useApp((s) => s.navParam);
  const courseSlug = useApp((s) => s.courseSlug);
  const setNavParam = useApp((s) => s.setNavParam);
  const setCourseSlug = useApp((s) => s.setCourseSlug);

  const [data, setData] = React.useState<CourseData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [openUnits, setOpenUnits] = React.useState<string[]>([]);

  const reload = React.useCallback(() => {
    setLoading(true);
    setError(null);
    // No hardcoded fallback slug: guessing a course here made an
    // unenrolled/direct-navigation user look like they were enrolled in
    // whichever course happened to be hardcoded. When there is no navParam
    // (e.g. the sidebar's Course tab navigates to this view with no slug),
    // resolve the student's CURRENT COURSE from their own authorized data —
    // GET /api/students/me/current-course applies the platform's existing
    // current-course rule (the student's group → that group's course, the
    // same `group.course` the dashboard's "كل الكورس" flow navigates with) —
    // and hand it to the SAME navParam mechanism every other flow uses. The
    // resolved slug then flows through the unchanged authorized content
    // fetch below, so this path can never open a course the student is not
    // enrolled in: /api/courses/[slug] still 403s server-side.
    // Always validate persisted navigation against the authoritative current
    // course. Zustand persistence can retain an old slug after enrollment/group
    // changes; never issue a request for that stale course.
    fetch("/api/students/me/current-course")
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(r.status === 403 || r.status === 401 ? "forbidden" : "fail")))
      .then((current) => {
        const authoritativeSlug = current?.course?.slug;
        if (!authoritativeSlug) throw new Error("empty");
        if (courseSlug !== authoritativeSlug) {
          setCourseSlug(authoritativeSlug);
          setNavParam(authoritativeSlug);
          return;
        }
        return fetch(`/api/courses/${encodeURIComponent(authoritativeSlug)}`)
          .then((r) => r.ok ? r.json() : Promise.reject(new Error(r.status === 403 || r.status === 401 ? "forbidden" : "fail")))
          .then((d) => {
            setData(d);
            const ids: string[] = [];
            for (const p of (d as CourseData).parts) if (p.units[0]) ids.push(p.units[0].id);
            setOpenUnits(ids);
          });
      })
      .then(() => { if (navParam) setLoading(false); })
      .catch((e: Error) => {
        setError(tr(e.message === "forbidden" ? "course.212" : e.message === "empty" ? "course.213" : "course.034"));
        setLoading(false);
      });
    return;
  }, [navParam, courseSlug, tr, setNavParam, setCourseSlug]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (loading) return <CourseSkeleton />;
  if (error || !data)
    return (
      <Card className="glass">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-base font-semibold mb-1">{error || tr("course.035")}</p>
          <Button variant="outline" className="mt-3" onClick={reload}>
            {tr("course.036")}</Button>
        </CardContent>
      </Card>
    );

  return (
    <div className="space-y-5">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col md:flex-row md:items-start gap-3 md:gap-5"
      >
        <div className="flex-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-muted-foreground"
              onClick={() => setView("student-dashboard")}
            >
              <ArrowRight className="w-3.5 h-3.5 ms-1 flip-rtl" />
              {tr("course.037")}</Button>
            <span>{tr("course.038")}</span>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold flex items-center gap-3">
            <span
              className="grid place-items-center w-10 h-10 rounded-xl text-white text-sm font-bold shrink-0"
              style={{ backgroundColor: data.course.color }}
            >
              <BookOpen className="w-5 h-5" />
            </span>
            <span className="text-gradient">{pickAuto(data.course.nameAr, data.course.name)}</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
            {data.course.description}
          </p>
        </div>
        <Card className="glass w-full md:w-72 shrink-0">
          <CardContent className="pt-5 pb-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Course Progress</div>
              <div className="text-2xl font-bold text-gradient">
                {data.progress.percentage}%
              </div>
            </div>
            <Progress value={data.progress.percentage} />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                {data.progress.completedLessons} {tr("course.039")}</span>
              <span className="flex items-center gap-1">
                <Layers className="w-3.5 h-3.5" />
                {data.progress.totalLessons} Lessons
              </span>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <LegendDot color="bg-primary" label={tr("course.039")} />
        <LegendDot color="bg-amber-400" label={tr("course.041")} />
        <LegendDot color="bg-muted-foreground/30" label={tr("course.042")} />
        <LegendDot color="bg-muted-foreground/50" label={tr("course.043")} icon="lock" />
      </div>

      {/* Parts timeline */}
      <div className="space-y-4">
        {data.parts.map((part, pIdx) => {
          const partLessons = part.units.flatMap((u) => [
            ...u.lessons,
            ...u.topics.flatMap((t) => t.lessons),
          ]);
          const partCompleted = partLessons.filter(
            (l) => l.isCompleted
          ).length;
          const partPct =
            partLessons.length > 0
              ? Math.round((partCompleted / partLessons.length) * 100)
              : 0;

          return (
            <motion.div
              key={part.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.05 * (pIdx + 1) }}
            >
              <Card className="glass overflow-hidden">
                <CardHeader className="border-b border-border/60">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary text-sm font-bold">
                        {pIdx + 1}
                      </div>
                      <div>
                        <CardTitle className="text-base">
                          {pickAuto(part.titleAr, part.title)}
                        </CardTitle>
                        {part.description && (
                          <CardDescription className="text-xs mt-0.5 max-w-xl">
                            {part.description}
                          </CardDescription>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="bg-muted/50">
                        {partCompleted}/{partLessons.length}
                      </Badge>
                      <div className="text-sm font-bold text-gradient">
                        {partPct}%
                      </div>
                    </div>
                  </div>
                  <Progress value={partPct} className="mt-2 h-1" />
                </CardHeader>
                <CardContent className="p-0">
                  <Accordion
                    type="multiple"
                    value={openUnits}
                    onValueChange={(v) => setOpenUnits(v as string[])}
                    className="w-full"
                  >
                    {part.units.map((unit) => (
                      <AccordionItem
                        key={unit.id}
                        value={unit.id}
                        className="border-b border-border/40 last:border-0"
                      >
                        <AccordionTrigger className="px-5 hover:bg-muted/30 transition-colors">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <div className="grid place-items-center w-8 h-8 rounded-lg bg-amber-400/15 text-amber-500 shrink-0">
                              <Layers className="w-4 h-4" />
                            </div>
                            <div className="text-end min-w-0">
                              <div className="text-sm font-semibold truncate">
                                {pickAuto(unit.titleAr, unit.title)}
                              </div>
                              <UnitCountSummary unit={unit} />
                            </div>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="px-5 pb-4 space-y-3">
                            {unit.lessons.length > 0 && (
                              <ul className="space-y-1.5">
                                {unit.lessons.map((lesson) => (
                                  <LessonRow
                                    key={lesson.id}
                                    lesson={lesson}
                                  />
                                ))}
                              </ul>
                            )}
                            {unit.topics
                              .filter((topic) => topic.lessons.length > 0)
                              .map((topic) => (
                              <div
                                key={topic.id}
                                className="rounded-lg bg-muted/30 p-3"
                              >
                                <div className="flex items-center gap-2 mb-2">
                                  <Sparkles className="w-3.5 h-3.5 text-primary" />
                                  <div className="text-sm font-medium">
                                    {pickAuto(topic.titleAr, topic.title)}
                                  </div>
                                </div>
                                <ul className="space-y-1.5">
                                  {topic.lessons.map((lesson) => (
                                    <LessonRow
                                      key={lesson.id}
                                      lesson={lesson}
                                    />
                                  ))}
                                </ul>
                              </div>
                            ))}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// LessonRow
// ============================================================
function LessonRow({ lesson }: { lesson: LessonItem }) {
  const tr = useT();
  const setView = useApp((s) => s.setView);
  const setNavParam = useApp((s) => s.setNavParam);

  const isLocked = lesson.status === "locked";

  // Phase H — when the server explained WHY this session is locked, that
  // sentence is what the student is answered with. `course.044` stays the
  // fallback for a row the engine did not evaluate (a legacy/anonymous read),
  // so the tree never invents a reason of its own.
  const lockReason =
    isLocked && lesson.progression?.reason?.text
      ? lesson.progression.reason.text
      : tr("course.044");

  const open = () => {
    if (isLocked) {
      toast.warning(lockReason);
      return;
    }
    setView("student-lesson");
    useApp.getState().setLessonId(lesson.id);
    setNavParam(lesson.id);
  };

  const StatusIcon =
    lesson.status === "completed" ? (
      <CheckCircle2 className="w-4 h-4 text-primary" />
    ) : lesson.status === "current" ? (
      <PlayCircle className="w-4 h-4 text-amber-500" />
    ) : lesson.status === "locked" ? (
      <Lock className="w-4 h-4 text-muted-foreground/60" />
    ) : (
      <Circle className="w-4 h-4 text-muted-foreground/40" />
    );

  const inner = (
    <motion.button
      whileHover={isLocked ? undefined : { x: -3 }}
      onClick={open}
      disabled={isLocked}
      className={`group w-full flex items-center gap-3 p-2.5 rounded-lg border transition-all ${
        isLocked
          ? "cursor-not-allowed border-transparent bg-muted/20 opacity-60"
          : "border-transparent hover:border-primary/30 hover:bg-primary/5 cursor-pointer"
      }`}
    >
      <div className="grid place-items-center w-7 h-7 rounded-full bg-background border border-border/60 shrink-0">
        {StatusIcon}
      </div>
      <div className="flex-1 min-w-0 text-end">
        <div className="text-sm font-medium flex items-center gap-1.5">
          {/* Phase 16 — session identity chip. Skeleton metadata: safe on
              locked rows, because the API serialises it for every status. */}
          {lesson.officialCode && (
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary tabular-nums">
              {lesson.officialCode}
            </span>
          )}
          <span className="truncate min-w-0">
            {lesson.order}. {pickAuto(lesson.titleAr, lesson.title)}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {lesson.duration} {tr("course.045")}</span>
          {/* Phase C — content indicator chips. One row of compact icons that
              reads the SAME server-side Lesson Content Summary the lesson
              workspace and the dashboard use (`lesson.content`): video,
              material (+ count), quiz, homework. Presence only — no ids, no
              titles, no URLs; identical numbers on every surface. The legacy
              boolean flags stay as a defensive fallback for stale payloads. */}
          <span className="flex items-center gap-1 flex-wrap">
            {(lesson.content?.video.count ?? 0) > 0 || lesson.hasVideo ? (
              <ContentChip
                icon={<Video className="w-3 h-3" />}
                label={tr("course.220")}
                tone="primary"
              />
            ) : null}
            {((lesson.content?.material.count ?? lesson.materialCount ?? 0) > 0 ||
              lesson.hasPdf) && (
              <ContentChip
                icon={<FileText className="w-3 h-3" />}
                label={tr("course.221")}
                tone="amber"
                count={(lesson.content?.material.count ?? lesson.materialCount ?? 0) > 1
                  ? (lesson.content?.material.count ?? lesson.materialCount)
                  : null}
              />
            )}
            {(lesson.content?.quiz.count ?? 0) > 0 ||
            (lesson.hasQuiz ?? !!lesson.quiz) ? (
              <ContentChip
                icon={<Trophy className="w-3 h-3" />}
                label={tr("course.237")}
                tone="primary"
              />
            ) : null}
            {(lesson.content?.homework.count ?? 0) > 0 ||
            (lesson.hasAssignment ?? !!lesson.homework) ? (
              <ContentChip
                icon={<ClipboardList className="w-3 h-3" />}
                label={tr("course.238")}
                tone="amber"
              />
            ) : null}
          </span>
          {/* Phase H — a locked session says WHY, in Arabic, on the row
              itself: a tooltip is invisible on mobile and a bare padlock
              tells the student nothing about what to do next. The text is the
              server's canonical sentence — the component never builds one. */}
          {isLocked && lesson.progression?.reason?.text ? (
            <span className="mt-1 flex items-start gap-1 text-[11px] text-muted-foreground">
              <Lock className="mt-0.5 w-3 h-3 shrink-0" />
              <span className="text-start">{lesson.progression.reason.text}</span>
            </span>
          ) : null}
        </div>
      </div>
      {lesson.isCompleted && (
        <Badge
          variant="outline"
          className="border-primary/30 text-primary bg-primary/10 text-[10px]"
        >
          ✅
        </Badge>
      )}
      {!isLocked && (
        <ChevronLeft className="w-4 h-4 text-muted-foreground/60 group-hover:text-primary flip-rtl" />
      )}
    </motion.button>
  );

  if (isLocked) {
    return (
      <li>
        <Tooltip>
          <TooltipTrigger asChild>{inner}</TooltipTrigger>
          {/* Phase H — the canonical reason, not a generic "locked" string. */}
          <TooltipContent side="top">
            {lesson.progression?.reason?.text ?? tr("course.046")}
          </TooltipContent>
        </Tooltip>
      </li>
    );
  }
  return <li>{inner}</li>;
}

// ============================================================
// Helpers
// ============================================================
/**
 * Phase C — one compact content indicator chip. Icon-only (the label rides on
 * aria-label + title for accessibility and RTL safety), sized to the tree
 * row, wrapped by the parent flex row on narrow screens. `tone` mirrors the
 * accent the lesson page uses for the same component (video/quiz = primary,
 * material/homework = amber), so the tree and the workspace speak the same
 * visual language.
 */
function ContentChip({
  icon,
  label,
  tone,
  count,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "primary" | "amber";
  count?: number | null;
}) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex items-center gap-0.5 h-5 min-w-5 px-1 rounded-md text-[10px] font-semibold tabular-nums ${
        tone === "primary"
          ? "bg-primary/10 text-primary"
          : "bg-amber-400/15 text-amber-500"
      }`}
    >
      {icon}
      {typeof count === "number" && count > 1 ? `×${count}` : null}
    </span>
  );
}

function LegendDot({
  color,
  label,
  icon,
}: {
  color: string;
  label: string;
  icon?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
      {icon === "lock" && <Lock className="w-3 h-3" />}
      {label}
    </div>
  );
}

function CourseSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-6 w-80" />
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
