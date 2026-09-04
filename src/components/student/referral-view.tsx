"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion } from "framer-motion";
import { useApp } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Gift,
  Copy,
  Share2,
  Users,
  TrendingUp,
  Award,
  ChevronLeft,
  Sparkles,
  CheckCircle2,
  Clock,
} from "lucide-react";

type ReferralData = {
  referralCode: string;
  shareUrl: string;
  stats: {
    total: number;
    completed: number;
    rewarded: number;
    pending: number;
    totalXpEarned: number;
  };
  referrals: {
    id: string;
    status: string;
    rewardValue: number;
    createdAt: string;
    completedAt: string | null;
    referredName: string;
    referredEmail: string;
  }[];
};

export function ReferralView() {
  const t = useT();
  const setView = useApp((s) => s.setView);
  const [data, setData] = React.useState<ReferralData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [copied, setCopied] = React.useState(false);

  const reload = React.useCallback(() => {
    setLoading(true);
    fetch("/api/students/me/referral")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => toast.error(t("student.083")))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const copyCode = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.referralCode);
      setCopied(true);
      toast.success(t("student.084"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("student.085"));
    }
  };

  const shareLink = async () => {
    if (!data) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "CodeMind Academy",
          text: t("student.086"),
          url: data.shareUrl,
        });
      } catch {
        // user cancelled
      }
    } else {
      await navigator.clipboard.writeText(data.shareUrl);
      toast.success(t("student.087"));
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      <button
        onClick={() => setView("student-dashboard")}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ChevronLeft className="w-4 h-4 flip-rtl" />
        {t("student.088")}</button>

      {/* Hero card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <Card className="glass card-hover overflow-hidden relative">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-amber-400/5 to-transparent" />
          <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-primary via-teal-500 to-amber-500" />
          <CardContent className="relative p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="grid place-items-center w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-amber-500 text-white shadow-lg">
                <Gift className="w-7 h-7" />
              </div>
              <div>
                <h2 className="text-xl font-bold">Referral Program</h2>
                <p className="text-xs text-muted-foreground">
                  {t("student.089")}</p>
              </div>
            </div>

            {/* Referral code */}
            <div className="rounded-xl bg-background/60 border border-border/40 p-4">
              <div className="text-xs text-muted-foreground mb-1.5">{t("student.090")}</div>
              <div className="flex items-center gap-2">
                <div className="flex-1 font-mono text-2xl font-extrabold text-gradient tracking-wider">
                  {data.referralCode}
                </div>
                <Button
                  size="sm"
                  variant={copied ? "default" : "outline"}
                  onClick={copyCode}
                  className="shrink-0"
                >
                  {copied ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 ms-1" />
                      {t("student.091")}</>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 ms-1" />
                      {t("student.092")}</>
                  )}
                </Button>
              </div>
            </div>

            {/* Share button */}
            <Button
              onClick={shareLink}
              className="w-full mt-3 bg-gradient-to-r from-primary to-teal-500 font-bold"
            >
              <Share2 className="w-4 h-4 ms-2" />
              {t("student.093")}</Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Stats grid */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="grid grid-cols-2 sm:grid-cols-4 gap-3"
      >
        <StatCard
          icon={Users}
          label={t("student.094")}
          value={data.stats.total}
          color="from-emerald-400 to-teal-500"
        />
        <StatCard
          icon={CheckCircle2}
          label={t("student.095")}
          value={data.stats.completed}
          color="from-teal-400 to-cyan-500"
        />
        <StatCard
          icon={Clock}
          label={t("student.096")}
          value={data.stats.pending}
          color="from-amber-400 to-orange-500"
        />
        <StatCard
          icon={Award}
          label={t("student.097")}
          value={data.stats.totalXpEarned}
          color="from-orange-400 to-rose-500"
        />
      </motion.div>

      {/* Referrals list */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-primary" />
              {t("student.098")}</CardTitle>
            <CardDescription className="text-xs">
              {t("student.099")}</CardDescription>
          </CardHeader>
          <CardContent>
            {data.referrals.length === 0 ? (
              <div className="text-center py-8">
                <div className="w-14 h-14 rounded-2xl bg-muted/40 flex items-center justify-center mx-auto mb-3">
                  <Users className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-semibold">{t("student.100")}</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                  {t("student.101")}</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto pe-1">
                {data.referrals.map((r, i) => (
                  <motion.div
                    key={r.id}
                    initial={{ opacity: 0, x: 10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className="flex items-center gap-3 p-3 rounded-lg border border-border/60 hover:border-primary/30 transition-all"
                  >
                    <div className="grid place-items-center w-10 h-10 rounded-full bg-gradient-to-br from-primary/20 to-amber-400/20 text-primary font-bold text-sm shrink-0">
                      {r.referredName.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate">
                        {r.referredName}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {r.referredEmail}
                      </div>
                    </div>
                    <div className="text-start shrink-0">
                      <Badge
                        variant="outline"
                        className={
                          r.status === "REWARDED"
                            ? "border-primary/30 text-primary bg-primary/10"
                            : r.status === "COMPLETED"
                            ? "border-emerald-400/30 text-emerald-600 bg-emerald-400/10"
                            : "border-amber-400/30 text-amber-600 bg-amber-400/10"
                        }
                      >
                        {r.status === "REWARDED" ? t("student.102") : r.status === "COMPLETED" ? t("student.095") : t("student.096")}
                      </Badge>
                      {r.status === "REWARDED" && (
                        <div className="text-xs text-primary font-bold mt-0.5">
                          +{r.rewardValue} XP
                        </div>
                      )}
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* How it works */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <Card className="glass border-primary/20">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-amber-500" />
              {t("student.105")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {[
                { num: 1, text: t("student.106") },
                { num: 2, text: t("student.107") },
                { num: 3, text: t("student.108") },
                { num: 4, text: t("student.109") },
              ].map((step) => (
                <div key={step.num} className="flex items-start gap-3">
                  <div className="grid place-items-center w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-bold shrink-0">
                    {step.num}
                  </div>
                  <div className="text-sm pt-0.5">{step.text}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <Card className="glass card-hover">
      <CardContent className="p-4">
        <div className={`grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br ${color} text-white mb-2`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="text-2xl font-extrabold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
