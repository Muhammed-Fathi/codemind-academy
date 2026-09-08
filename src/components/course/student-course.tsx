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
  isLocked: boolean;
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
  quiz: { id: string; title: string; titleAr: string } | null;
  homework: { id: string; title: string; titleAr: string } | null;
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

/** Every session of a unit, in the order the progression engine enforces. */
function unitLessons(unit: UnitItem): LessonItem[] {
  return [...unit.lessons, ...unit.topics.flatMap((t) => t.lessons)];
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

  const [data, setData] = React.useState<CourseData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [openUnits, setOpenUnits] = React.useState<string[]>([]);

  const reload = React.useCallback(() => {
    setLoading(true);
    setError(null);
    // No hardcoded fallback slug: guessing a course here made an
    // unenrolled/direct-navigation user look like they were enrolled in
    // whichever course happened to be hardcoded. With no navParam there is
    // simply nothing to load.
    if (!navParam) {
      setError(tr("course.213"));
      setLoading(false);
      return;
    }
    fetch(`/api/courses/${encodeURIComponent(navParam)}`)
      .then((r) => {
        if (r.ok) return r.json();
        // 403 is an authorization outcome, not a transport failure, and it
        // must not be collapsed into the generic "try again" message — the
        // student would retry forever. The server stays the source of truth.
        if (r.status === 403 || r.status === 401)
          return Promise.reject(new Error("forbidden"));
        return Promise.reject(new Error("fail"));
      })
      .then((d) => {
        setData(d);
        const ids: string[] = [];
        for (const p of (d as CourseData).parts) {
          if (p.units[0]) ids.push(p.units[0].id);
        }
        setOpenUnits(ids);
      })
      .catch((e: Error) => {
        setError(tr(e.message === "forbidden" ? "course.212" : "course.034"));
      })
      .finally(() => setLoading(false));
  }, [navParam, tr]);

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
                              <div className="text-[11px] text-muted-foreground">
                                {unit.topics.length} Topics ·{" "}
                                {unitLessons(unit).length} Lessons
                              </div>
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

  const open = () => {
    if (isLocked) {
      toast.warning(tr("course.044"));
      return;
    }
    setView("student-lesson");
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
        <div className="text-sm font-medium truncate">
          {lesson.order}. {pickAuto(lesson.titleAr, lesson.title)}
        </div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
          <Clock className="w-3 h-3" />
          {lesson.duration} {tr("course.045")}{(lesson.hasQuiz ?? !!lesson.quiz) && (
            <span className="flex items-center gap-0.5">
              · <Trophy className="w-3 h-3" /> Quiz
            </span>
          )}
          {(lesson.hasAssignment ?? !!lesson.homework) && (
            <span className="flex items-center gap-0.5">
              · <FileText className="w-3 h-3" /> Homework
            </span>
          )}
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
          <TooltipContent side="top">{tr("course.046")}</TooltipContent>
        </Tooltip>
      </li>
    );
  }
  return <li>{inner}</li>;
}

// ============================================================
// Helpers
// ============================================================
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
