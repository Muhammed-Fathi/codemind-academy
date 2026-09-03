"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { useApp } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Bookmark,
  BookmarkCheck,
  Trash2,
  ChevronLeft,
  BookOpen,
  Sparkles,
} from "lucide-react";

type Bookmark = {
  id: string;
  lessonId: string;
  createdAt: string;
  lesson: {
    id: string;
    title: string;
    titleAr: string;
    topic: { unit: { part: { titleAr: string; title: string } } };
  };
};

export function BookmarksView() {
  const setView = useApp((s) => s.setView);
  const setNavParam = useApp((s) => s.setNavParam);
  const [items, setItems] = React.useState<Bookmark[]>([]);
  const [loading, setLoading] = React.useState(true);

  const reload = React.useCallback(() => {
    setLoading(true);
    fetch("/api/students/me/bookmarks")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setItems(d?.bookmarks || []))
      .catch(() => toast.error("حصلت مشكلة"))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const remove = async (lessonId: string) => {
    await fetch(`/api/students/me/bookmarks?lessonId=${encodeURIComponent(lessonId)}`, {
      method: "DELETE",
    });
    toast.success("اتشال الـBookmark");
    reload();
  };

  return (
    <div className="space-y-4">
      <button
        onClick={() => setView("student-dashboard")}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ChevronLeft className="w-4 h-4 flip-rtl" />
        رجوع
      </button>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="glass card-hover">
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="grid place-items-center w-10 h-10 rounded-xl bg-amber-400/15 text-amber-500">
                <BookmarkCheck className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-lg">Bookmarks</CardTitle>
                <CardDescription>
                  الـLessons اللي حفظتها لمراجعة سريعة
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="text-center py-10">
                <div className="w-14 h-14 rounded-2xl bg-muted/40 flex items-center justify-center mx-auto mb-3">
                  <Bookmark className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-semibold">مفيش Bookmarks لسه</p>
                <p className="text-xs text-muted-foreground mt-1">
                  افتح أي Lesson واضغط على علامة Bookmark عشان تحفظها هنا.
                </p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => setView("student-course")}
                >
                  <BookOpen className="w-4 h-4 ml-2" />
                  تصفح الكورس
                </Button>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto pr-2">
                {items.map((b, i) => (
                  <motion.div
                    key={b.id}
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="group flex items-center gap-3 p-3 rounded-xl border border-border/60 hover:border-amber-400/40 hover:bg-amber-400/5 transition-all"
                  >
                    <div className="grid place-items-center w-10 h-10 rounded-lg bg-amber-400/15 text-amber-500 group-hover:scale-110 transition-transform">
                      <BookmarkCheck className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate">
                        {b.lesson.titleAr || b.lesson.title}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {b.lesson.topic?.unit?.part?.titleAr}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setView("student-lesson");
                        setNavParam(b.lessonId);
                      }}
                    >
                      افتح
                      <ChevronLeft className="w-3.5 h-3.5 flip-rtl" />
                    </Button>
                    <button
                      onClick={() => remove(b.lessonId)}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
                      title="اتشال"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </motion.div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
