"use client";
import { useT, useLocale , pickAuto } from "@/lib/i18n";

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
import { useApp } from "@/lib/store";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Clock,
  FileText,
  Trophy,
  Video,
  BookOpen,
  PlayCircle,
  ClipboardList,
  GraduationCap,
  Bookmark,
  BookmarkCheck,
  StickyNote,
  Plus,
  Trash2,
  Loader2,
  Edit3,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

// ============================================================
// Types
// ============================================================
type LessonView = {
  lesson: {
    id: string;
    title: string;
    titleAr: string;
    description: string | null;
    summary: string | null;
    duration: number;
    order: number;
    videoUrl: string | null;
    /** Phase 14: authorized material path or legacy external URL. Never a storageKey. */
    pdfUrl: string | null;
    /** Phase 14: safe material descriptors (id + downloadUrl only). */
    materials?: {
      id: string;
      title: string;
      kind: string;
      trackScope: string;
      downloadUrl: string | null;
      mimeType: string | null;
      sizeBytes: number | null;
      legacy: boolean;
    }[];
    // Phase 13: `isLocked` removed — the retired column is no longer sent, and
    // gating is decided by the server (`access.allowed`), never by the client.
  };
  part: { id: string; title: string; titleAr: string } | null;
  unit: { id: string; title: string; titleAr: string } | null;
  /** Legacy-only: canonical unit-linked lessons have no topic. */
  topic: { id: string; title: string; titleAr: string } | null;
  course: { id: string; slug: string; name: string; nameAr: string } | null;
  /** All quizzes of the session — the progression engine requires every one. */
  quizzes: {
    id: string;
    title: string;
    titleAr: string;
    description: string | null;
    passMark: number;
    questions: unknown[];
  }[];
  /** First quiz (backwards-compatible shorthand for `quizzes[0]`). */
  quiz: {
    id: string;
    title: string;
    titleAr: string;
    description: string | null;
    passMark: number;
    questions: unknown[];
  } | null;
  homework: {
    id: string;
    title: string;
    titleAr: string;
    instructions: string | null;
    deadline: string;
    maxMarks: number;
  } | null;
  progress: {
    progress: number;
    isCompleted: boolean;
    lastViewedAt: string | null;
  } | null;
  prevLessonId: string | null;
  nextLessonId: string | null;
};

// ============================================================
// Main
// ============================================================
export function StudentLessonView() {
  const t = useT();
  const locale = useLocale();
  const setView = useApp((s) => s.setView);
  const setNavParam = useApp((s) => s.setNavParam);
  const navParam = useApp((s) => s.navParam);

  const [data, setData] = React.useState<LessonView | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [completing, setCompleting] = React.useState(false);
  const [bookmarked, setBookmarked] = React.useState(false);

  const checkBookmark = React.useCallback(() => {
    if (!navParam) return;
    fetch("/api/students/me/bookmarks")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const found = (d?.bookmarks || []).some((b: any) => b.lessonId === navParam);
        setBookmarked(found);
      })
      .catch(() => {});
  }, [navParam]);

  const toggleBookmark = async () => {
    if (!navParam) return;
    if (bookmarked) {
      await fetch(`/api/students/me/bookmarks?lessonId=${encodeURIComponent(navParam)}`, {
        method: "DELETE",
      });
      setBookmarked(false);
      toast.success(t("course.047"));
    } else {
      await fetch("/api/students/me/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: navParam }),
      });
      setBookmarked(true);
      toast.success(t("course.048"));
    }
  };

  React.useEffect(() => {
    checkBookmark();
  }, [checkBookmark]);

  const reload = React.useCallback(() => {
    if (!navParam) {
      setError(t("course.049"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/lessons/${encodeURIComponent(navParam)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fail"))))
      .then((d) => setData(d))
      .catch(() => {
        setError(t("course.050"));
      })
      .finally(() => setLoading(false));
  }, [navParam]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (loading) return <LessonSkeleton />;

  if (error || !data)
    return (
      <Card className="glass">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-base font-semibold mb-1">
            {error || t("course.051")}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => setView("student-course")}
          >
            <ArrowRight className="w-4 h-4 ms-1.5 flip-rtl" />
            {t("course.052")}</Button>
        </CardContent>
      </Card>
    );

  const progressPct = data.progress?.progress || 0;
  const isCompleted = data.progress?.isCompleted || false;

  const markComplete = async () => {
    setCompleting(true);
    try {
      const res = await fetch(
        `/api/lessons/${encodeURIComponent(data.lesson.id)}/progress`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ completed: true }),
        }
      );
      if (!res.ok) throw new Error("fail");
      toast.success(t("course.053"));
      setData({
        ...data,
        progress: {
          progress: 100,
          isCompleted: true,
          lastViewedAt: new Date().toISOString(),
        },
      });
    } catch {
      toast.error(t("course.054"));
    } finally {
      setCompleting(false);
    }
  };

  const gotoLesson = (id: string) => {
    setView("student-lesson");
    setNavParam(id);
  };

  return (
    <div className="space-y-5">
      {/* Breadcrumb + Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="space-y-2"
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            className="px-2 text-muted-foreground"
            onClick={() => {
              setView("student-course");
              if (data.course) setNavParam(data.course.slug);
            }}
          >
            <ArrowRight className="w-3.5 h-3.5 ms-1 flip-rtl" />
            {t("course.055")}</Button>
          {data.part && (
            <>
              <span>{pickAuto(data.part.titleAr, data.part.title)}</span>
              <span>›</span>
            </>
          )}
          {data.unit && (
            <>
              <span>{pickAuto(data.unit.titleAr, data.unit.title)}</span>
              <span>›</span>
            </>
          )}
          {data.topic ? (
            <span className="text-foreground">
              {pickAuto(data.topic.titleAr, data.topic.title)}
            </span>
          ) : (
            <span className="text-foreground">
              {pickAuto(data.lesson.titleAr, data.lesson.title)}
            </span>
          )}
        </div>
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold leading-tight">
              <span className="text-gradient">
                {pickAuto(data.lesson.titleAr, data.lesson.title)}
              </span>
            </h1>
            {data.lesson.description && (
              <p className="text-sm text-muted-foreground mt-1.5 max-w-2xl">
                {data.lesson.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="bg-muted/50">
              <Clock className="w-3 h-3 ms-1" />
              {data.lesson.duration} {t("course.056")}</Badge>
            {isCompleted ? (
              <Badge
                variant="outline"
                className="border-primary/30 text-primary bg-primary/10"
              >
                <CheckCircle2 className="w-3.5 h-3.5 ms-1" />
                Completed
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber-400/30 text-amber-600 bg-amber-400/10"
              >
                <PlayCircle className="w-3.5 h-3.5 ms-1" />
                {t("course.057")}</Badge>
            )}
            <button
              onClick={toggleBookmark}
              className={`grid place-items-center w-7 h-7 rounded-md transition-all hover:scale-110 ${
                bookmarked
                  ? "bg-amber-400/20 text-amber-500"
                  : "bg-muted text-muted-foreground hover:bg-amber-400/10 hover:text-amber-500"
              }`}
              title={bookmarked ? t("course.047") : t("course.059")}
            >
              {bookmarked ? (
                <BookmarkCheck className="w-4 h-4" />
              ) : (
                <Bookmark className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 pt-1">
          <Progress value={progressPct} className="flex-1" />
          <span className="text-xs text-muted-foreground font-medium">
            {progressPct}%
          </span>
        </div>
      </motion.div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left: video + materials */}
        <div className="lg:col-span-2 space-y-4">
          {/* Video */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
          >
            <Card className="glass overflow-hidden">
              <div className="aspect-video bg-black/90 relative">
                {data.lesson.videoUrl ? (
                  <iframe
                    src={data.lesson.videoUrl}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    className="absolute inset-0 w-full h-full"
                    title={pickAuto(data.lesson.titleAr, data.lesson.title)}
                  />
                ) : (
                  <div className="absolute inset-0 grid place-items-center text-center">
                    <div>
                      <div className="grid place-items-center w-16 h-16 rounded-full bg-white/10 mx-auto mb-3">
                        <Video className="w-8 h-8 text-white/80" />
                      </div>
                      <p className="text-white/80 text-sm">
                        {t("course.060")}</p>
                      <p className="text-white/40 text-xs mt-1">
                        {t("course.061")}</p>
                    </div>
                  </div>
                )}
              </div>
            </Card>
          </motion.div>

          {/* Summary */}
          {data.lesson.summary && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 }}
            >
              <Card className="glass">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <BookOpen className="w-5 h-5 text-primary" />
                    {t("course.062")}</CardTitle>
                </CardHeader>
                <CardContent className="prose prose-sm dark:prose-invert max-w-none leading-relaxed text-foreground/90">
                  <ReactMarkdown>{data.lesson.summary}</ReactMarkdown>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* PDF / session materials (Phase 14 — authorized download paths) */}
          {((data.lesson.materials && data.lesson.materials.length > 0) ||
            data.lesson.pdfUrl) && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.12 }}
            >
              <Card className="glass">
                <CardContent className="space-y-3 py-4">
                  {(data.lesson.materials && data.lesson.materials.length > 0
                    ? data.lesson.materials
                    : [
                        {
                          id: "legacy",
                          title: t("course.063"),
                          kind: "LEGACY_URL",
                          trackScope: "SHARED",
                          downloadUrl: data.lesson.pdfUrl,
                          mimeType: "application/pdf",
                          sizeBytes: null,
                          legacy: true,
                        },
                      ]
                  ).map((m) => {
                    const href = m.downloadUrl
                      ? m.legacy
                        ? m.downloadUrl
                        : `${m.downloadUrl}?download=1`
                      : null;
                    if (!href) return null;
                    return (
                      <div key={m.id} className="flex items-center gap-3">
                        <div className="grid place-items-center w-10 h-10 rounded-lg bg-amber-400/15 text-amber-500">
                          <FileText className="w-5 h-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold">
                            {m.title || t("course.063")}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {t("course.064")}
                          </div>
                        </div>
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex"
                        >
                          <Button variant="outline">
                            <FileText className="w-4 h-4 ms-1.5" />
                            {t("course.065")}
                          </Button>
                        </a>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* Mark complete */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
          >
            <Card className="glass">
              <CardContent className="flex flex-col sm:flex-row items-start sm:items-center gap-3 py-4">
                <div className="grid place-items-center w-10 h-10 rounded-lg bg-primary/10 text-primary shrink-0">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">
                    {isCompleted
                      ? t("course.066")
                      : t("course.067")}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {isCompleted
                      ? t("course.068")
                      : t("course.069")}
                  </div>
                </div>
                <Button
                  onClick={markComplete}
                  disabled={completing || isCompleted}
                  variant={isCompleted ? "secondary" : "default"}
                >
                  <CheckCircle2 className="w-4 h-4 ms-1.5" />
                  {isCompleted ? t("course.070") : "Mark as Complete"}
                </Button>
              </CardContent>
            </Card>
          </motion.div>

          {/* Prev / Next */}
          <div className="flex items-center justify-between gap-2 pt-2">
            {data.prevLessonId ? (
              <Button
                variant="outline"
                onClick={() => gotoLesson(data.prevLessonId!)}
              >
                <ArrowRight className="w-4 h-4 ms-1.5 flip-rtl" />
                {t("course.071")}</Button>
            ) : (
              <span />
            )}
            {data.nextLessonId ? (
              <Button onClick={() => gotoLesson(data.nextLessonId!)}>
                {t("course.072")}<ArrowLeft className="w-4 h-4 ms-1.5 flip-rtl" />
              </Button>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                {t("course.073")}</Badge>
            )}
          </div>
        </div>

        {/* Right sidebar: Quiz + Homework */}
        <div className="space-y-4">
          {/* Quiz */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
          >
            <Card className="glass card-hover">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
                    <Trophy className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Quiz</CardTitle>
                    <CardDescription className="text-xs">
                      {t("course.074")}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {data.quizzes.length > 0 ? (
                  <div className="space-y-4">
                    {/* One card per quiz: the Phase 4 engine requires EVERY
                        quiz of a session to be attempted before the session
                        completes, so each one must be reachable here. */}
                    {data.quizzes.map((q) => (
                      <div key={q.id} className="space-y-3">
                        <div>
                          <div className="text-sm font-semibold">
                            {pickAuto(q.titleAr, q.title)}
                          </div>
                          {q.description && (
                            <div className="text-xs text-muted-foreground mt-1">
                              {q.description}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className="bg-muted/50">
                            {q.questions.length} Questions
                          </Badge>
                          <Badge variant="outline" className="bg-muted/50">
                            Pass: {q.passMark}%
                          </Badge>
                        </div>
                        <Button
                          className="w-full"
                          onClick={() => {
                            setView("student-quiz");
                            setNavParam(q.id);
                          }}
                        >
                          <Trophy className="w-4 h-4 ms-1.5" />
                          {t("course.075")}
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-3 text-sm text-muted-foreground">
                    <Trophy className="w-5 h-5 mx-auto mb-1 opacity-40" />
                    {t("course.076")}</div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Homework */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
          >
            <Card className="glass card-hover">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <div className="grid place-items-center w-9 h-9 rounded-lg bg-amber-400/15 text-amber-500">
                    <ClipboardList className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Homework</CardTitle>
                    <CardDescription className="text-xs">
                      {t("course.077")}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {data.homework ? (
                  <div className="space-y-3">
                    <div>
                      <div className="text-sm font-semibold">
                        {pickAuto(data.homework.titleAr, data.homework.title)}
                      </div>
                      {data.homework.instructions && (
                        <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          {data.homework.instructions}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className="bg-muted/50">
                        <Clock className="w-3 h-3 ms-1" />
                        {new Intl.DateTimeFormat(
                          locale === "en" ? "en-GB" : "ar-EG",
                          {
                            day: "numeric",
                            month: "short",
                          }
                        ).format(new Date(data.homework.deadline))}
                      </Badge>
                      <Badge variant="outline" className="bg-muted/50">
                        <GraduationCap className="w-3 h-3 ms-1" />
                        {data.homework.maxMarks} {t("course.078")}</Badge>
                    </div>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => setView("student-homework")}
                    >
                      <ClipboardList className="w-4 h-4 ms-1.5" />
                      {t("course.079")}</Button>
                  </div>
                ) : (
                  <div className="text-center py-3 text-sm text-muted-foreground">
                    <ClipboardList className="w-5 h-5 mx-auto mb-1 opacity-40" />
                    {t("course.080")}</div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* Quick tip */}
          <Card className="glass border-primary/20">
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary shrink-0">
                  <PlayCircle className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-sm font-semibold mb-0.5">{t("course.081")}</div>
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    {t("course.082")}</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Notes */}
          <LessonNotesSection lessonId={navParam} />
        </div>
      </div>
    </div>
  );
}

function LessonSkeleton() {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-2 w-full" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Skeleton className="aspect-video w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Lesson Notes Section — sticky notes for the student
// ============================================================
function LessonNotesSection({ lessonId }: { lessonId: string | null }) {
  const t = useT();
  const locale = useLocale();
  const [notes, setNotes] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [adding, setAdding] = React.useState(false);
  const [newNote, setNewNote] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editContent, setEditContent] = React.useState("");

  const reload = React.useCallback(() => {
    if (!lessonId) return;
    setLoading(true);
    fetch(`/api/students/me/notes?lessonId=${encodeURIComponent(lessonId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setNotes(d?.notes || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [lessonId]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const addNote = async () => {
    if (!newNote.trim() || !lessonId) return;
    setSaving(true);
    try {
      const r = await fetch("/api/students/me/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId, content: newNote.trim() }),
      });
      if (!r.ok) {
        toast.error(t("course.083"));
        return;
      }
      setNewNote("");
      setAdding(false);
      toast.success(t("course.084"));
      reload();
    } finally {
      setSaving(false);
    }
  };

  const updateNote = async (noteId: string) => {
    if (!editContent.trim()) return;
    setSaving(true);
    try {
      const r = await fetch("/api/students/me/notes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteId, content: editContent.trim() }),
      });
      if (!r.ok) {
        toast.error(t("course.085"));
        return;
      }
      setEditingId(null);
      setEditContent("");
      toast.success(t("course.086"));
      reload();
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (noteId: string) => {
    await fetch(`/api/students/me/notes?noteId=${encodeURIComponent(noteId)}`, {
      method: "DELETE",
    });
    toast.success(t("course.087"));
    reload();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.2 }}
    >
      <Card className="glass card-hover">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="grid place-items-center w-9 h-9 rounded-lg bg-amber-400/15 text-amber-500">
                <StickyNote className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-base">{t("course.088")}</CardTitle>
                <CardDescription className="text-xs">
                  {t("course.089")}</CardDescription>
              </div>
            </div>
            {!adding && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setAdding(true)}
                className="h-8 px-2"
              >
                <Plus className="w-4 h-4" />
                {t("course.090")}</Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2.5">
          {loading ? (
            <Skeleton className="h-20" />
          ) : (
            <>
              {adding && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="space-y-2"
                >
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder={t("course.091")}
                    className="min-h-[80px] resize-none text-sm bg-amber-400/5 border-amber-400/30 focus-visible:ring-amber-400/40"
                    autoFocus
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={addNote}
                      disabled={!newNote.trim() || saving}
                      className="h-8"
                    >
                      {saving ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        t("course.092")
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAdding(false);
                        setNewNote("");
                      }}
                      className="h-8"
                    >
                      {t("course.093")}</Button>
                  </div>
                </motion.div>
              )}

              {notes.length === 0 && !adding ? (
                <div className="text-center py-4">
                  <StickyNote className="w-8 h-8 text-muted-foreground/40 mx-auto mb-1.5" />
                  <p className="text-xs text-muted-foreground">
                    {t("course.094")}</p>
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pe-1">
                  {notes.map((n) => (
                    <motion.div
                      key={n.id}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="group relative rounded-lg bg-amber-400/10 border border-amber-400/20 p-3 hover:border-amber-400/40 transition-colors"
                    >
                      {editingId === n.id ? (
                        <div className="space-y-2">
                          <Textarea
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            className="min-h-[60px] resize-none text-xs bg-background"
                            autoFocus
                          />
                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              onClick={() => updateNote(n.id)}
                              disabled={saving}
                              className="h-7 text-xs"
                            >
                              {saving ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                t("course.092")
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingId(null);
                                setEditContent("");
                              }}
                              className="h-7 text-xs"
                            >
                              {t("course.093")}</Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-xs leading-relaxed whitespace-pre-wrap pe-6">
                            {n.content}
                          </p>
                          <div className="mt-1.5 text-[10px] text-muted-foreground">
                            {new Date(n.updatedAt).toLocaleDateString(
                              locale === "en" ? "en-GB" : "ar-EG",
                              {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              }
                            )}
                          </div>
                          <div className="absolute top-2 start-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => {
                                setEditingId(n.id);
                                setEditContent(n.content);
                              }}
                              className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              title={t("course.097")}
                            >
                              <Edit3 className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => deleteNote(n.id)}
                              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                              title={t("course.098")}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </>
                      )}
                    </motion.div>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
