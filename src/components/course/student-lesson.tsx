"use client";

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
    pdfUrl: string | null;
    isLocked: boolean;
  };
  part: { id: string; title: string; titleAr: string };
  unit: { id: string; title: string; titleAr: string };
  topic: { id: string; title: string; titleAr: string };
  course: { id: string; slug: string; name: string; nameAr: string };
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
      toast.success("اتشال الـBookmark");
    } else {
      await fetch("/api/students/me/bookmarks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: navParam }),
      });
      setBookmarked(true);
      toast.success("اتضاف الـBookmark ⭐");
    }
  };

  React.useEffect(() => {
    checkBookmark();
  }, [checkBookmark]);

  const reload = React.useCallback(() => {
    if (!navParam) {
      setError("مفيش Lesson محددة. ارجع للكورس واختار واحدة.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/lessons/${encodeURIComponent(navParam)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fail"))))
      .then((d) => setData(d))
      .catch(() => {
        setError("حصلت مشكلة وإحنا بنجيب الـLesson. حاول تاني.");
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
            {error || "مفيش بيانات"}
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => setView("student-course")}
          >
            <ArrowRight className="w-4 h-4 ml-1.5 flip-rtl" />
            ارجع للكورس
          </Button>
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
      toast.success("اتسجّلت كـ Completed ✅");
      setData({
        ...data,
        progress: {
          progress: 100,
          isCompleted: true,
          lastViewedAt: new Date().toISOString(),
        },
      });
    } catch {
      toast.error("حصلت مشكلة، حاول تاني.");
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
              setNavParam(data.course.slug);
            }}
          >
            <ArrowRight className="w-3.5 h-3.5 ml-1 flip-rtl" />
            رجوع للكورس
          </Button>
          <span>›</span>
          <span>{data.part.titleAr}</span>
          <span>›</span>
          <span>{data.unit.titleAr}</span>
          <span>›</span>
          <span className="text-foreground">{data.topic.titleAr}</span>
        </div>
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold leading-tight">
              <span className="text-gradient">
                {data.lesson.titleAr || data.lesson.title}
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
              <Clock className="w-3 h-3 ml-1" />
              {data.lesson.duration} دقيقة
            </Badge>
            {isCompleted ? (
              <Badge
                variant="outline"
                className="border-primary/30 text-primary bg-primary/10"
              >
                <CheckCircle2 className="w-3.5 h-3.5 ml-1" />
                Completed
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber-400/30 text-amber-600 bg-amber-400/10"
              >
                <PlayCircle className="w-3.5 h-3.5 ml-1" />
                في السير
              </Badge>
            )}
            <button
              onClick={toggleBookmark}
              className={`grid place-items-center w-7 h-7 rounded-md transition-all hover:scale-110 ${
                bookmarked
                  ? "bg-amber-400/20 text-amber-500"
                  : "bg-muted text-muted-foreground hover:bg-amber-400/10 hover:text-amber-500"
              }`}
              title={bookmarked ? "اتشال الـBookmark" : "حفظ كـBookmark"}
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
                    title={data.lesson.titleAr || data.lesson.title}
                  />
                ) : (
                  <div className="absolute inset-0 grid place-items-center text-center">
                    <div>
                      <div className="grid place-items-center w-16 h-16 rounded-full bg-white/10 mx-auto mb-3">
                        <Video className="w-8 h-8 text-white/80" />
                      </div>
                      <p className="text-white/80 text-sm">
                        الفيديو هيتضاف قريب
                      </p>
                      <p className="text-white/40 text-xs mt-1">
                        تابع الـLesson من المواد اللي تحت
                      </p>
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
                    ملخص الـLesson
                  </CardTitle>
                </CardHeader>
                <CardContent className="prose prose-sm dark:prose-invert max-w-none leading-relaxed text-foreground/90">
                  <ReactMarkdown>{data.lesson.summary}</ReactMarkdown>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* PDF */}
          {data.lesson.pdfUrl && (
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.12 }}
            >
              <Card className="glass">
                <CardContent className="flex items-center gap-3 py-4">
                  <div className="grid place-items-center w-10 h-10 rounded-lg bg-amber-400/15 text-amber-500">
                    <FileText className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold">مادة PDF</div>
                    <div className="text-xs text-muted-foreground">
                      حمّل مذكرة الـLesson
                    </div>
                  </div>
                  <a
                    href={data.lesson.pdfUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex"
                  >
                    <Button variant="outline">
                      <FileText className="w-4 h-4 ml-1.5" />
                      فتح
                    </Button>
                  </a>
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
                      ? "خلصت الـLesson دي ✅"
                      : "خلصت الـLesson؟"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {isCompleted
                      ? "تقدر تروح للـLesson اللي بعدها."
                      : "علمها كـCompleted عشان نحسبها في تقدمك."}
                  </div>
                </div>
                <Button
                  onClick={markComplete}
                  disabled={completing || isCompleted}
                  variant={isCompleted ? "secondary" : "default"}
                >
                  <CheckCircle2 className="w-4 h-4 ml-1.5" />
                  {isCompleted ? "اتخلصت" : "Mark as Complete"}
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
                <ArrowRight className="w-4 h-4 ml-1.5 flip-rtl" />
                السابق
              </Button>
            ) : (
              <span />
            )}
            {data.nextLessonId ? (
              <Button onClick={() => gotoLesson(data.nextLessonId!)}>
                التالي
                <ArrowLeft className="w-4 h-4 ml-1.5 flip-rtl" />
              </Button>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                آخر Lesson في الكورس 🎉
              </Badge>
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
                      اختبر فهمك
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {data.quiz ? (
                  <div className="space-y-3">
                    <div>
                      <div className="text-sm font-semibold">
                        {data.quiz.titleAr || data.quiz.title}
                      </div>
                      {data.quiz.description && (
                        <div className="text-xs text-muted-foreground mt-1">
                          {data.quiz.description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="bg-muted/50">
                        {data.quiz.questions.length} Questions
                      </Badge>
                      <Badge variant="outline" className="bg-muted/50">
                        Pass: {data.quiz.passMark}%
                      </Badge>
                    </div>
                    <Button
                      className="w-full"
                      onClick={() => {
                        setView("student-quiz");
                        setNavParam(data.quiz!.id);
                      }}
                    >
                      <Trophy className="w-4 h-4 ml-1.5" />
                      ابدأ Quiz
                    </Button>
                  </div>
                ) : (
                  <div className="text-center py-3 text-sm text-muted-foreground">
                    <Trophy className="w-5 h-5 mx-auto mb-1 opacity-40" />
                    مفيش Quiz على الـLesson دي
                  </div>
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
                      شوف الواجب
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {data.homework ? (
                  <div className="space-y-3">
                    <div>
                      <div className="text-sm font-semibold">
                        {data.homework.titleAr || data.homework.title}
                      </div>
                      {data.homework.instructions && (
                        <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                          {data.homework.instructions}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className="bg-muted/50">
                        <Clock className="w-3 h-3 ml-1" />
                        {new Intl.DateTimeFormat("ar-EG", {
                          day: "numeric",
                          month: "short",
                        }).format(new Date(data.homework.deadline))}
                      </Badge>
                      <Badge variant="outline" className="bg-muted/50">
                        <GraduationCap className="w-3 h-3 ml-1" />
                        {data.homework.maxMarks} درجات
                      </Badge>
                    </div>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => setView("student-homework")}
                    >
                      <ClipboardList className="w-4 h-4 ml-1.5" />
                      افتح الواجبات
                    </Button>
                  </div>
                ) : (
                  <div className="text-center py-3 text-sm text-muted-foreground">
                    <ClipboardList className="w-5 h-5 mx-auto mb-1 opacity-40" />
                    مفيش Homework على الـLesson دي
                  </div>
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
                  <div className="text-sm font-semibold mb-0.5">نصيحة 💡</div>
                  <div className="text-xs text-muted-foreground leading-relaxed">
                    اتفرج على الفيديو كامل، وبعدين حل الـQuiz عشان تثبت المعلومة.
                  </div>
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
        toast.error("فشل حفظ الملاحظة");
        return;
      }
      setNewNote("");
      setAdding(false);
      toast.success("اتحفظت الملاحظة 📝");
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
        toast.error("فشل تحديث الملاحظة");
        return;
      }
      setEditingId(null);
      setEditContent("");
      toast.success("اتحدثت الملاحظة");
      reload();
    } finally {
      setSaving(false);
    }
  };

  const deleteNote = async (noteId: string) => {
    await fetch(`/api/students/me/notes?noteId=${encodeURIComponent(noteId)}`, {
      method: "DELETE",
    });
    toast.success("اتمسحت الملاحظة");
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
                <CardTitle className="text-base">ملاحظاتي</CardTitle>
                <CardDescription className="text-xs">
                  دوّن أهم النقط
                </CardDescription>
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
                أضف
              </Button>
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
                    placeholder="اكتب ملاحظتك هنا..."
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
                        "احفظ"
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
                      إلغاء
                    </Button>
                  </div>
                </motion.div>
              )}

              {notes.length === 0 && !adding ? (
                <div className="text-center py-4">
                  <StickyNote className="w-8 h-8 text-muted-foreground/40 mx-auto mb-1.5" />
                  <p className="text-xs text-muted-foreground">
                    مفيش ملاحظات لسه. اضغط "أضف" عشان تكتب واحدة.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
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
                                "احفظ"
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
                              إلغاء
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="text-xs leading-relaxed whitespace-pre-wrap pr-6">
                            {n.content}
                          </p>
                          <div className="mt-1.5 text-[10px] text-muted-foreground">
                            {new Date(n.updatedAt).toLocaleDateString("ar-EG", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                          <div className="absolute top-2 left-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => {
                                setEditingId(n.id);
                                setEditContent(n.content);
                              }}
                              className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                              title="تعديل"
                            >
                              <Edit3 className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => deleteNote(n.id)}
                              className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                              title="مسح"
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
