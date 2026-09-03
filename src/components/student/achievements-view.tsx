"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { useApp } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Trophy,
  Lock,
  Star,
  Sparkles,
  ChevronLeft,
  Award,
  Zap,
  Flame,
  TrendingUp,
} from "lucide-react";

export function AchievementsView() {
  const setView = useApp((s) => s.setView);
  const [data, setData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch("/api/students/me/gamification")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => toast.error("حصلت مشكلة"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-32 rounded-2xl" />
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const earned = data.badges.filter((b: any) => b.earned);
  const locked = data.badges.filter((b: any) => !b.earned);
  const earnedPct = data.badges.length > 0
    ? Math.round((earned.length / data.badges.length) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <button
        onClick={() => setView("student-dashboard")}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ChevronLeft className="w-4 h-4 flip-rtl" />
        رجوع
      </button>

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <Card className="glass card-hover overflow-hidden relative">
          <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-amber-500 via-primary to-teal-500" />
          <CardContent className="p-5">
            <div className="flex items-center gap-3 mb-4">
              <div className="grid place-items-center w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white shadow-lg">
                <Trophy className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold">Achievements</h2>
                <p className="text-xs text-muted-foreground">
                  {earned.length} من {data.badges.length} شارة مفتوحة ({earnedPct}%)
                </p>
              </div>
            </div>
            <Progress value={earnedPct} className="h-2" />
          </CardContent>
        </Card>
      </motion.div>

      {/* Stats summary */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="glass card-hover">
          <CardContent className="p-3 text-center">
            <div className="grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white mx-auto mb-1.5">
              <Star className="w-4 h-4" />
            </div>
            <div className="text-xl font-extrabold text-gradient">{data.xp}</div>
            <div className="text-[10px] text-muted-foreground">Total XP</div>
          </CardContent>
        </Card>
        <Card className="glass card-hover">
          <CardContent className="p-3 text-center">
            <div className="grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-teal-400 to-cyan-500 text-white mx-auto mb-1.5">
              <Zap className="w-4 h-4" />
            </div>
            <div className="text-xl font-extrabold">Lvl {data.level.current.level}</div>
            <div className="text-[10px] text-muted-foreground">{data.level.current.title}</div>
          </CardContent>
        </Card>
        <Card className="glass card-hover">
          <CardContent className="p-3 text-center">
            <div className="grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-orange-400 to-rose-500 text-white mx-auto mb-1.5">
              <Flame className="w-4 h-4" />
            </div>
            <div className="text-xl font-extrabold">{data.stats.currentStreak}</div>
            <div className="text-[10px] text-muted-foreground">Day Streak</div>
          </CardContent>
        </Card>
      </div>

      {/* Earned badges */}
      {earned.length > 0 && (
        <div>
          <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            Badges المفتوحة ({earned.length})
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {earned.map((b: any, i: number) => (
              <motion.div
                key={b.code}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: i * 0.05, type: "spring", stiffness: 200 }}
              >
                <Card className="glass card-hover border-amber-400/30 bg-gradient-to-br from-amber-400/10 to-orange-500/5">
                  <CardContent className="p-4 text-center">
                    <div className="text-4xl mb-2 float-icon">{b.icon}</div>
                    <div className="text-sm font-bold">{b.titleAr}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">{b.title}</div>
                    <div className="text-[9px] text-muted-foreground mt-2 leading-relaxed">
                      {b.description}
                    </div>
                    <Badge className="mt-2 bg-amber-400/20 text-amber-600 text-[10px]">
                      <Trophy className="w-2.5 h-2.5 ml-1" />
                      مفتوحة
                    </Badge>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Locked badges */}
      {locked.length > 0 && (
        <div>
          <h3 className="text-sm font-bold mb-3 flex items-center gap-2">
            <Lock className="w-4 h-4 text-muted-foreground" />
            Badges المقفولة ({locked.length})
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {locked.map((b: any, i: number) => (
              <motion.div
                key={b.code}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.1 + i * 0.05 }}
              >
                <Card className="glass opacity-70 hover:opacity-100 transition-opacity border-border/40">
                  <CardContent className="p-4 text-center">
                    <div className="text-4xl mb-2 grayscale opacity-40">{b.icon}</div>
                    <div className="text-sm font-bold">{b.titleAr}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">{b.title}</div>
                    <div className="text-[9px] text-muted-foreground mt-2 leading-relaxed">
                      {b.description}
                    </div>
                    <Badge variant="outline" className="mt-2 text-[10px] text-muted-foreground">
                      <Lock className="w-2.5 h-2.5 ml-1" />
                      مقفولة
                    </Badge>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      )}

      {/* Level progress */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-primary" />
            Level Progress
          </CardTitle>
          <CardDescription className="text-xs">
            Level {data.level.current.level} → {data.level.next ? `Level ${data.level.next.level}` : "Max"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <div className={`grid place-items-center w-8 h-8 rounded-lg bg-gradient-to-br ${data.level.current.color} text-white font-bold text-xs`}>
                {data.level.current.level}
              </div>
              <div>
                <div className="font-bold">{data.level.current.title}</div>
                <div className="text-xs text-muted-foreground">{data.xp} XP</div>
              </div>
            </div>
            {data.level.next && (
              <div className="text-left">
                <div className="font-bold text-muted-foreground">{data.level.next.title}</div>
                <div className="text-xs text-muted-foreground">{data.level.xpToNext} XP للـLevel اللي جاي</div>
              </div>
            )}
          </div>
          <Progress value={data.level.progress} className="h-3" />
        </CardContent>
      </Card>
    </div>
  );
}
