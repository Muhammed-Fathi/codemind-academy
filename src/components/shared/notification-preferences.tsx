"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Bell,
  BookOpen,
  Trophy,
  FileText,
  Clock,
  CalendarClock,
  TrendingDown,
  FileBarChart,
  ShieldCheck,
  Megaphone,
  Mail,
  Smartphone,
  Moon,
  Save,
  Loader2,
} from "lucide-react";

type Prefs = {
  newLesson: boolean;
  newQuiz: boolean;
  quizResult: boolean;
  newHomework: boolean;
  homeworkDeadline: boolean;
  upcomingSession: boolean;
  lowAttendance: boolean;
  monthlyReport: boolean;
  subscriptionExpiration: boolean;
  announcements: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
};

const PREF_CONFIG: {
  key: keyof Prefs;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { key: "newLesson", label: "shared.001", desc: "shared.002", icon: BookOpen },
  { key: "newQuiz", label: "shared.003", desc: "shared.004", icon: Trophy },
  { key: "quizResult", label: "shared.005", desc: "shared.006", icon: Trophy },
  { key: "newHomework", label: "shared.007", desc: "shared.008", icon: FileText },
  { key: "homeworkDeadline", label: "shared.009", desc: "shared.010", icon: Clock },
  { key: "upcomingSession", label: "shared.011", desc: "shared.012", icon: CalendarClock },
  { key: "lowAttendance", label: "shared.013", desc: "shared.014", icon: TrendingDown },
  { key: "monthlyReport", label: "shared.015", desc: "shared.016", icon: FileBarChart },
  { key: "subscriptionExpiration", label: "shared.017", desc: "shared.018", icon: ShieldCheck },
  { key: "announcements", label: "shared.019", desc: "shared.020", icon: Megaphone },
];

export function NotificationPreferences() {
  const t = useT();
  const [prefs, setPrefs] = React.useState<Prefs | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  const reload = React.useCallback(() => {
    setLoading(true);
    fetch("/api/students/me/notification-prefs")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPrefs(d?.prefs || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const toggle = (key: keyof Prefs) => {
    if (!prefs) return;
    setPrefs({ ...prefs, [key]: !prefs[key] });
  };

  const save = async () => {
    if (!prefs) return;
    setSaving(true);
    try {
      const r = await fetch("/api/students/me/notification-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(prefs),
      });
      if (!r.ok) {
        toast.error(t("shared.021"));
        return;
      }
      toast.success(t("shared.022"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-16" />
        ))}
      </div>
    );
  }

  if (!prefs) return null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <Card className="glass card-hover overflow-hidden relative">
          <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-primary via-teal-500 to-amber-500" />
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <div className="grid place-items-center w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-teal-500 text-white shadow-lg">
                <Bell className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-lg font-bold">Notification Preferences</h2>
                <p className="text-xs text-muted-foreground">
                    {t("shared.023")}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Notification types */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base">{t("shared.024")}</CardTitle>
            <CardDescription className="text-xs">
              {t("shared.025")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {PREF_CONFIG.map((p, i) => (
              <motion.div
                key={p.key}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.05 * i }}
                className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/40 transition-colors group"
              >
                <div className={`grid place-items-center w-9 h-9 rounded-lg shrink-0 transition-colors ${
                  prefs[p.key] ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  <p.icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">{t(p.label)}</div>
                  <div className="text-xs text-muted-foreground">{t(p.desc)}</div>
                </div>
                <Switch
                  checked={prefs[p.key] as boolean}
                  onCheckedChange={() => toggle(p.key)}
                />
              </motion.div>
            ))}
          </CardContent>
        </Card>
      </motion.div>

      {/* Channel preferences */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base">{t("shared.026")}</CardTitle>
            <CardDescription className="text-xs">
              {t("shared.027")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/40 transition-colors">
              <div className={`grid place-items-center w-9 h-9 rounded-lg shrink-0 ${
                prefs.pushEnabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              }`}>
                <Smartphone className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold">Push Notifications</div>
                <div className="text-xs text-muted-foreground">{t("shared.028")}</div>
              </div>
              <Switch
                checked={prefs.pushEnabled}
                onCheckedChange={() => toggle("pushEnabled")}
              />
            </div>
            <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-muted/40 transition-colors">
              <div className={`grid place-items-center w-9 h-9 rounded-lg shrink-0 ${
                prefs.emailEnabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              }`}>
                <Mail className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-semibold">Email</div>
                <div className="text-xs text-muted-foreground">
                  {t("shared.029")}</div>
              </div>
              <Switch
                checked={prefs.emailEnabled}
                onCheckedChange={() => toggle("emailEnabled")}
              />
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Quiet hours */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
      >
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Moon className="w-5 h-5 text-amber-500" />
              {t("shared.030")}</CardTitle>
            <CardDescription className="text-xs">
              {t("shared.031")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">{t("shared.032")}</Label>
                <Input
                  type="time"
                  value={prefs.quietHoursStart || ""}
                  onChange={(e) =>
                    setPrefs({ ...prefs, quietHoursStart: e.target.value || null })
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">{t("shared.033")}</Label>
                <Input
                  type="time"
                  value={prefs.quietHoursEnd || ""}
                  onChange={(e) =>
                    setPrefs({ ...prefs, quietHoursEnd: e.target.value || null })
                  }
                  className="mt-1"
                />
              </div>
            </div>
            {(prefs.quietHoursStart || prefs.quietHoursEnd) && (
              <Badge variant="outline" className="mt-3 bg-amber-400/10 text-amber-600 border-amber-400/30">
                <Moon className="w-3 h-3 ms-1" />
                {t("shared.034")}{prefs.quietHoursStart || t("shared.035")} {t("shared.036")}{prefs.quietHoursEnd || t("shared.035")}
              </Badge>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Save button */}
      <div className="flex justify-end">
        <Button
          onClick={save}
          disabled={saving}
          size="lg"
          className="font-bold bg-gradient-to-r from-primary to-teal-500"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 ms-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 ms-2" />
          )}
          {saving ? t("shared.038") : t("shared.039")}
        </Button>
      </div>
    </div>
  );
}
