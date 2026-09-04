"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion } from "framer-motion";
import { useApp } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { toast } from "sonner";
import {
  Trophy,
  Medal,
  Crown,
  Flame,
  TrendingUp,
  ChevronLeft,
  Star,
  Award,
  Sparkles,
  Zap,
  Users,
} from "lucide-react";

type LeaderEntry = {
  studentId: string;
  name: string;
  avatarUrl: string | null;
  xp: number;
  level: number;
  levelTitle: string;
  levelColor: string;
  badgeCount: number;
  totalBadges: number;
  streak: number;
  quizzesPassed: number;
  lessonsCompleted: number;
  rank: number;
};

export function LeaderboardView() {
  const t = useT();
  const setView = useApp((s) => s.setView);
  const user = useApp((s) => s.user);
  const [data, setData] = React.useState<{
    leaderboard: LeaderEntry[];
    myRank: number;
    myStats: any;
  } | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    fetch("/api/students/me/leaderboard")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => toast.error(t("student.040")))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
    );
  }

  if (!data) return null;

  const { leaderboard, myRank, myStats } = data;
  const top3 = leaderboard.slice(0, 3);
  const rest = leaderboard.slice(3);

  return (
    <div className="space-y-4">
      <button
        onClick={() => setView("student-dashboard")}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ChevronLeft className="w-4 h-4 flip-rtl" />
        {t("student.041")}</button>

      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <Card className="glass card-hover overflow-hidden relative">
          <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-amber-500 via-primary to-teal-500" />
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="grid place-items-center w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-white shadow-lg">
                <Trophy className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold">Leaderboard</h2>
                <p className="text-xs text-muted-foreground">
                  {t("student.042")}{myRank}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* My rank card */}
      {myStats && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.05 }}
        >
          <Card className="glass border-primary/30 bg-primary/5">
            <CardContent className="p-4">
              <div className="flex items-center gap-4">
                <div className="grid place-items-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-teal-500 text-white font-bold text-xl shrink-0">
                  #{myRank}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold">{t("student.043")}{user?.name}</div>
                  <div className="flex items-center gap-2 mt-1">
                    <Badge className="bg-primary/15 text-primary text-xs">
                      <Star className="w-3 h-3 ms-1 fill-primary" />
                      Level {myStats.level} · {myStats.levelTitle}
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      <Zap className="w-3 h-3 ms-1 text-amber-500" />
                      {myStats.xp} XP
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      <Award className="w-3 h-3 ms-1 text-amber-500" />
                      {myStats.badgeCount} Badges
                    </Badge>
                  </div>
                </div>
                <div className="text-start shrink-0">
                  <div className="flex items-center gap-1 text-sm font-bold text-orange-500">
                    <Flame className="w-4 h-4" />
                    {myStats.streak}
                  </div>
                  <div className="text-[10px] text-muted-foreground">Day Streak</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Top 3 podium */}
      {top3.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Crown className="w-5 h-5 text-amber-500" />
                Top 3
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3">
                {top3.map((entry, i) => {
                  const isGold = i === 0;
                  const isSilver = i === 1;
                  const isBronze = i === 2;
                  const podiumColor = isGold
                    ? "from-amber-400 to-amber-500"
                    : isSilver
                    ? "from-slate-300 to-slate-400"
                    : "from-orange-400 to-orange-500";
                  const podiumHeight = isGold ? "h-28" : isSilver ? "h-24" : "h-20";
                  const medalIcon = isGold ? "🥇" : isSilver ? "🥈" : "🥉";

                  return (
                    <motion.div
                      key={entry.studentId}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 + i * 0.1, type: "spring", stiffness: 200 }}
                      className="text-center"
                    >
                      <div className="flex flex-col items-center gap-2">
                        <Avatar className={`w-14 h-14 ring-4 ${
                          isGold ? "ring-amber-400" : isSilver ? "ring-slate-300" : "ring-orange-400"
                        }`}>
                          <AvatarFallback className={`bg-gradient-to-br ${podiumColor} text-white font-bold`}>
                            {entry.name.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="text-sm font-bold truncate max-w-full">
                          {entry.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {entry.xp} XP · Lvl {entry.level}
                        </div>
                      </div>
                      <motion.div
                        initial={{ scaleY: 0 }}
                        animate={{ scaleY: 1 }}
                        transition={{ delay: 0.3 + i * 0.1, duration: 0.4 }}
                        className={`${podiumHeight} mt-3 rounded-t-xl bg-gradient-to-b ${podiumColor} flex items-start justify-center pt-2 origin-bottom`}
                      >
                        <span className="text-2xl">{medalIcon}</span>
                      </motion.div>
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Full ranking list */}
      {rest.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
        >
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="w-5 h-5 text-primary" />
                {t("student.044")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-96 overflow-y-auto pe-1">
                {rest.map((entry, i) => {
                  const isMe = entry.name === user?.name;
                  return (
                    <motion.div
                      key={entry.studentId}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.03 }}
                      className={`flex items-center gap-3 p-3 rounded-lg border transition-all ${
                        isMe
                          ? "border-primary/40 bg-primary/5"
                          : "border-border/40 hover:border-primary/20 hover:bg-muted/30"
                      }`}
                    >
                      <div className="grid place-items-center w-8 h-8 rounded-lg bg-muted/50 text-xs font-bold text-muted-foreground shrink-0">
                        {entry.rank}
                      </div>
                      <Avatar className="w-9 h-9 shrink-0">
                        <AvatarFallback className={`bg-gradient-to-br ${entry.levelColor} text-white text-xs font-bold`}>
                          {entry.name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {entry.name}
                          {isMe && <span className="text-primary me-1"> {t("student.045")}</span>}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <Badge variant="outline" className="text-[10px]">
                            <Star className="w-2.5 h-2.5 ms-0.5 text-amber-500" />
                            Lvl {entry.level}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            <Award className="w-2.5 h-2.5 ms-0.5 text-amber-500" />
                            {entry.badgeCount}
                          </Badge>
                          <Badge variant="outline" className="text-[10px]">
                            <Flame className="w-2.5 h-2.5 ms-0.5 text-orange-500" />
                            {entry.streak}
                          </Badge>
                        </div>
                      </div>
                      <div className="text-start shrink-0">
                        <div className="text-sm font-bold text-gradient">
                          {entry.xp}
                        </div>
                        <div className="text-[10px] text-muted-foreground">XP</div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Motivational footer */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <Card className="glass border-amber-400/20">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="grid place-items-center w-10 h-10 rounded-xl bg-amber-400/15 text-amber-500 shrink-0">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <div className="text-sm font-bold">{t("student.046")}</div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("student.047")}</p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setView("student-course")}
            >
              {t("student.048")}<ChevronLeft className="w-3.5 h-3.5 flip-rtl" />
            </Button>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
