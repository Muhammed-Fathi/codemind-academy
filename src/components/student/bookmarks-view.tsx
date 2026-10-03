"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion } from "framer-motion";
import { useApp } from "@/lib/store";
import { openStudentLesson } from "@/lib/student-navigation";
import { academicLevelLabelFor } from "@/lib/academic-level-labels";
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
    /** Printed session code — context only, NOT unique across levels. */
    officialCode: string | null;
    /** Derived cache; the course's level below is the authority when present. */
    academicLevel: string | null;
  };
  /**
   * Phase M4.2 — the disambiguating context, resolved server-side (canonical
   * `Lesson → Unit → Part → Course` first, legacy `Topic → Unit → Part → Course`
   * as the documented fallback). The lesson id stays the identity; the level +
   * code + unit/part are what let two identically-coded sessions be told apart.
   */
  context: {
    chain: "UNIT" | "TOPIC" | null;
    unit: { id: string; title: string; titleAr: string } | null;
    part: { id: string; title: string; titleAr: string } | null;
    course: { id: string; name: string; nameAr: string; academicLevel: string } | null;
  } | null;
};

export function BookmarksView() {
  const t = useT();
  const setView = useApp((s) => s.setView);
  const [items, setItems] = React.useState<Bookmark[]>([]);
  const [loading, setLoading] = React.useState(true);

  const reload = React.useCallback(() => {
    setLoading(true);
    fetch("/api/students/me/bookmarks")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setItems(d?.bookmarks || []))
      .catch(() => toast.error(t("student.010")))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const remove = async (lessonId: string) => {
    await fetch(`/api/students/me/bookmarks?lessonId=${encodeURIComponent(lessonId)}`, {
      method: "DELETE",
    });
    toast.success(t("student.011"));
    reload();
  };

  return (
    <div className="space-y-4">
      <button
        onClick={() => setView("student-dashboard")}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ChevronLeft className="w-4 h-4 flip-rtl" />
        {t("student.012")}</button>

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
                  {t("student.013")}</CardDescription>
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
                <p className="text-sm font-semibold">{t("student.014")}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t("student.015")}</p>
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => setView("student-course")}
                >
                  <BookOpen className="w-4 h-4 ms-2" />
                  {t("student.016")}</Button>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto pe-2">
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
                      <div className="text-sm font-semibold truncate flex items-center gap-1.5">
                        {b.lesson.officialCode && (
                          <span className="shrink-0 rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-600 tabular-nums">
                            {b.lesson.officialCode}
                          </span>
                        )}
                        <span className="truncate">{pickAuto(b.lesson.titleAr, b.lesson.title)}</span>
                      </div>
                      {/* Level + chain context: the SAME printed code and title
                          exist at both levels, so the level is rendered from
                          the canonical `Course.academicLevel` (falling back to
                          the lesson's derived cache when the chain is gone). */}
                      <div className="text-xs text-muted-foreground truncate">
                        <span className="font-medium text-foreground/70">
                          {academicLevelLabelFor(
                            t,
                            b.context?.course?.academicLevel ?? b.lesson.academicLevel
                          )}
                        </span>
                        {(() => {
                          const part = pickAuto(b.context?.part?.titleAr, b.context?.part?.title);
                          const unit = pickAuto(b.context?.unit?.titleAr, b.context?.unit?.title);
                          const chain = [part, unit].filter(Boolean).join(" › ");
                          return chain ? <> · {chain}</> : null;
                        })()}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        // Phase M4.2 — the canonical lesson id is the identity
                        // and the shared rule moves the view's fetch key.
                        openStudentLesson(useApp.getState(), b.lessonId);
                      }}
                    >
                      {t("student.017")}<ChevronLeft className="w-3.5 h-3.5 flip-rtl" />
                    </Button>
                    <button
                      onClick={() => remove(b.lessonId)}
                      className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
                      title={t("student.018")}
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
