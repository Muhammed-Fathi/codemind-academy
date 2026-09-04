"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Flame,
  Trophy,
  Star,
  Zap,
  Award,
  Sparkles,
  TrendingUp,
} from "lucide-react";

type Badge = {
  code: string;
  title: string;
  titleAr: string;
  description: string;
  descriptionEn?: string;
  icon: string;
  color: string;
  earned: boolean;
  earnedAt: string | null;
};

type GamificationData = {
  xp: number;
  level: {
    current: { level: number; title: string; titleEn: string; minXp: number; color: string };
    next: { level: number; title: string; titleEn: string; minXp: number; color: string } | null;
    progress: number;
    xpToNext: number;
  };
  stats: {
    lessonsCompleted: number;
    quizzesTaken: number;
    quizzesPassed: number;
    avgQuizPct: number;
    homeworkSubmitted: number;
    homeworkGraded: number;
    attendancePct: number;
    currentStreak: number;
    longestStreak: number;
  };
  badges: Badge[];
  newlyEarned: string[];
};

export function GamificationPanel() {
  const t = useT();
  const [data, setData] = React.useState<GamificationData | null>(null);
  const [loading, setLoading] = React.useState(true);

  const reload = React.useCallback(() => {
    setLoading(true);
    fetch("/api/students/me/gamification")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setData(d);
          // Show toast for newly earned badges
          if (d.newlyEarned?.length > 0) {
            for (const code of d.newlyEarned) {
              const b = d.badges.find((x) => x.code === code);
              if (b) {
                toast.success(t("student.034", { p1: pickAuto(b.titleAr, b.title), p2: b.icon }), {
                  duration: 5000,
                });
              }
            }
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return (
      <Card className="glass card-hover">
        <CardContent className="p-6">
          <div className="h-32 skeleton-shimmer rounded-xl" />
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-4"
    >
      {/* Level + XP card */}
      <Card className="glass card-hover overflow-hidden relative">
        <div className={cn("absolute inset-x-0 top-0 h-1.5 bg-gradient-to-l", data.level.current.color)} />
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className={cn(
                "grid place-items-center w-11 h-11 rounded-xl text-white bg-gradient-to-br shadow-lg",
                data.level.current.color
              )}>
                <Star className="w-5 h-5 fill-white" />
              </div>
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  Level {data.level.current.level}
                  <span className="text-xs font-normal text-muted-foreground">
                    · {pickAuto(data.level.current.title, data.level.current.titleEn)}
                  </span>
                </CardTitle>
                <CardDescription className="text-xs">
                  {data.level.next
                    ? t("student.035", { p1: data.level.xpToNext, p2: data.level.next.level, p3: pickAuto(data.level.next.title, data.level.next.titleEn) })
                    : t("student.036")}
                </CardDescription>
              </div>
            </div>
            <div className="text-start">
              <div className="text-2xl font-extrabold text-gradient">{data.xp}</div>
              <div className="text-[10px] text-muted-foreground">{t("student.037")}</div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <div>
            <Progress value={data.level.progress} className="h-2" />
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-1">
              <span>Level {data.level.current.level}</span>
              {data.level.next && <span>Level {data.level.next.level}</span>}
            </div>
          </div>
          {/* Mini stats row */}
          <div className="grid grid-cols-4 gap-2 pt-1">
            <MiniStat icon={Flame} value={data.stats.currentStreak} label="Day Streak" tone="orange" />
            <MiniStat icon={Trophy} value={data.stats.quizzesPassed} label="Quizzes" tone="emerald" />
            <MiniStat icon={Zap} value={data.stats.lessonsCompleted} label="Lessons" tone="teal" />
            <MiniStat icon={TrendingUp} value={`${data.stats.avgQuizPct}%`} label="Avg" tone="amber" />
          </div>
        </CardContent>
      </Card>

      {/* Badges card */}
      <Card className="glass card-hover">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="grid place-items-center w-9 h-9 rounded-lg bg-amber-400/15 text-amber-500">
                <Award className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-base">Badges</CardTitle>
                <CardDescription className="text-xs">
                  {data.badges.filter((b) => b.earned).length} {t("student.038")}{data.badges.length} {t("student.039")}</CardDescription>
              </div>
            </div>
            <Badge variant="outline" className="bg-amber-400/10 text-amber-600 border-amber-400/30">
              <Sparkles className="w-3 h-3 ms-1" />
              {data.badges.filter((b) => b.earned).length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5">
            {data.badges.map((b) => (
              <BadgeTile key={b.code} badge={b} />
            ))}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

function MiniStat({
  icon: Icon,
  value,
  label,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: number | string;
  label: string;
  tone: "orange" | "emerald" | "teal" | "amber";
}) {
  const toneClass = {
    orange: "text-orange-500 bg-orange-500/10",
    emerald: "text-primary bg-primary/10",
    teal: "text-teal-500 bg-teal-500/10",
    amber: "text-amber-500 bg-amber-500/10",
  }[tone];
  return (
    <div className="rounded-lg bg-muted/30 p-2.5 text-center">
      <div className={cn("w-7 h-7 rounded-md flex items-center justify-center mx-auto mb-1", toneClass)}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="text-sm font-bold">{value}</div>
      <div className="text-[9px] text-muted-foreground truncate">{label}</div>
    </div>
  );
}

function BadgeTile({ badge }: { badge: Badge }) {
  return (
    <motion.div
      whileHover={badge.earned ? { scale: 1.05, y: -2 } : {}}
      className={cn(
        "relative aspect-square rounded-xl flex flex-col items-center justify-center p-2 text-center border transition-all",
        badge.earned
          ? "border-amber-400/40 bg-gradient-to-br from-amber-400/10 to-orange-500/10 shadow-sm"
          : "border-border/40 bg-muted/20 opacity-50 grayscale"
      )}
      title={pickAuto(badge.description, badge.descriptionEn)}
    >
      <div className={cn(
        "text-2xl mb-1 transition-transform",
        badge.earned && "drop-shadow"
      )}>
        {badge.icon}
      </div>
      <div className="text-[10px] font-bold leading-tight line-clamp-2">
        {pickAuto(badge.titleAr, badge.title)}
      </div>
      {badge.earned && (
        <div className="absolute top-1 end-1 w-3.5 h-3.5 rounded-full bg-amber-400 flex items-center justify-center">
          <Trophy className="w-2 h-2 text-white" />
        </div>
      )}
    </motion.div>
  );
}
