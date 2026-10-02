"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { useT } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type IntegrityReport = {
  summary: {
    studentGroupMismatches: number;
    lessonMismatches: number;
    courses: number;
    students: number;
    lessons: number;
    orphanLessons: number;
  };
};

/**
 * Read-only Overview surface for the existing level-integrity audit.
 *
 * The endpoint remains the authority and this card never repairs or mutates
 * anything. Keeping this small component outside the dashboard monolith makes
 * the diagnostic independently reviewable while preserving every dashboard
 * view key and route contract.
 */
export function AdminIntegrityCard() {
  const tr = useT();
  const [report, setReport] = React.useState<IntegrityReport | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch("/api/admin/level-mismatches");
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "integrity");
      setReport(body);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <Card data-integrity-card="loading">
        <CardContent className="p-4">
          <div className="h-5 animate-pulse rounded bg-muted" aria-hidden="true" />
        </CardContent>
      </Card>
    );
  }
  if (error || !report) {
    return (
      <Card data-integrity-card="error">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <p className="text-sm text-destructive">{tr("admin.670")}</p>
          <Button type="button" size="sm" variant="outline" onClick={load}>
            <RefreshCw className="me-1.5 h-3.5 w-3.5" />{tr("admin.002")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const summary = report.summary;
  const mismatchCount =
    summary.studentGroupMismatches + summary.lessonMismatches;
  const legacyCount = summary.courses + summary.students + summary.lessons + summary.orphanLessons;
  const healthy = mismatchCount === 0 && legacyCount === 0;

  return (
    <Card
      data-integrity-card={healthy ? "healthy" : "warning"}
      className={healthy ? "border-emerald-500/30" : "border-amber-500/40"}
    >
      <CardHeader className="p-4 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{tr("admin.668")}</CardTitle>
          <Badge
            variant={healthy ? "outline" : "destructive"}
            className={healthy ? "border-emerald-500/30 text-emerald-700 dark:text-emerald-300" : ""}
          >
            {healthy ? (
              <><CheckCircle2 className="me-1.5 h-3.5 w-3.5" />{tr("admin.669")}</>
            ) : (
              <><AlertTriangle className="me-1.5 h-3.5 w-3.5" />{tr("admin.671")}</>
            )}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-2 space-y-3">
        <p className="text-xs text-muted-foreground">{tr(healthy ? "admin.672" : "admin.673")}</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-lg border p-2">
            <div className="text-[11px] text-muted-foreground">{tr("admin.674")}</div>
            <div className="text-lg font-bold tabular-nums">{summary.studentGroupMismatches}</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-[11px] text-muted-foreground">{tr("admin.675")}</div>
            <div className="text-lg font-bold tabular-nums">{summary.lessonMismatches}</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-[11px] text-muted-foreground">{tr("admin.676")}</div>
            <div className="text-lg font-bold tabular-nums">{legacyCount}</div>
          </div>
          <div className="rounded-lg border p-2">
            <div className="text-[11px] text-muted-foreground">{tr("admin.677")}</div>
            <div className="text-lg font-bold tabular-nums">{mismatchCount + legacyCount}</div>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="button" size="sm" variant="ghost" onClick={load}>
            <RefreshCw className="me-1.5 h-3.5 w-3.5" />{tr("admin.002")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
