"use client";

// ============================================================
// CodeMind Academy — Admin: Quiz camera review
//
// Shows the review evidence collected during quiz attempts (student, quiz,
// attempt, timestamp, snapshots). Evidence is sensitive personal data:
//   * this view is reachable only from the ADMIN navigation,
//   * the listing API re-checks the ADMIN role server-side,
//   * each image is streamed from /api/media/[id], which independently
//     re-checks the ADMIN role — there is no public URL.
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { useT, pickAuto } from "@/lib/i18n";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldCheck, Camera, CameraOff } from "lucide-react";

type EvidenceItem = {
  id: string;
  kind: string;
  status: string | null;
  capturedAt: string;
  retainUntil: string | null;
  url: string | null;
};

type AttemptRow = {
  attemptId: string;
  startedAt: string;
  finishedAt: string | null;
  percentage: number;
  cameraStatus: string;
  student: { id: string; name: string; email: string; studentCode: string | null };
  quiz: { id: string; title: string; titleAr: string };
  evidence: EvidenceItem[];
};

export function QuizReviewView() {
  const tr = useT();
  const [rows, setRows] = React.useState<AttemptRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(1);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/admin/quiz-evidence?page=${page}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setRows(d.attempts || []);
        setTotalPages(d.pagination?.totalPages || 1);
      })
      .catch(() => !cancelled && setRows([]))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [page]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      <div>
        <h2 className="text-xl font-bold">{tr("admin.245")}</h2>
        {/* Page subtitle — describes the review task, NOT the privacy notice.
            quiz.202 (the privacy message) is rendered exactly once below. */}
        <p className="text-xs text-muted-foreground">{tr("quiz.213")}</p>
      </div>

      {/* Privacy/notice callout — the single place quiz.202 appears. */}
      <Card className="border-amber-500/30 bg-amber-500/5 p-3">
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 w-4 h-4 shrink-0 text-amber-600" />
          <span>{tr("quiz.202")}</span>
        </p>
      </Card>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Card className="p-8">
          <p className="text-center text-sm text-muted-foreground">{tr("admin.246")}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <Card key={row.attemptId} className="p-4">
              <CardHeader className="p-0 pb-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base">{row.student.name}</CardTitle>
                    <CardDescription className="text-xs">
                      {pickAuto(row.quiz.titleAr, row.quiz.title)}
                      {row.student.studentCode && (
                        <>
                          {" · "}
                          <code dir="ltr">{row.student.studentCode}</code>
                        </>
                      )}
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {tr("admin.247")}: {row.percentage}%
                    </Badge>
                    <Badge
                      variant={row.cameraStatus === "GRANTED" ? "default" : "secondary"}
                      className="inline-flex items-center gap-1 text-[10px]"
                    >
                      {row.cameraStatus === "GRANTED" ? (
                        <Camera className="w-3 h-3" />
                      ) : (
                        <CameraOff className="w-3 h-3" />
                      )}
                      {row.cameraStatus}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="mb-2 text-[11px] text-muted-foreground">
                  {tr("admin.248")}: {new Date(row.startedAt).toLocaleString()}
                </div>
                <div className="flex flex-wrap gap-2">
                  {row.evidence.filter((e) => e.url).length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {tr("admin.246")}
                    </span>
                  ) : (
                    row.evidence
                      .filter((e) => e.url)
                      .map((e) => (
                        <figure key={e.id} className="w-28">
                          {/* Authorized, private stream URL — never a public path.
                              Plain <img> is deliberate: next/image would try to
                              optimize through its own loader, which cannot pass
                              the session cookie these role-checked bytes need. */}
                          <img
                            src={e.url!}
                            alt={`${row.student.name} — ${new Date(e.capturedAt).toLocaleTimeString()}`}
                            className="h-20 w-28 rounded-md border object-cover"
                            loading="lazy"
                          />
                          <figcaption className="mt-1 text-center text-[10px] text-muted-foreground">
                            {new Date(e.capturedAt).toLocaleTimeString()}
                          </figcaption>
                        </figure>
                      ))
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            {tr("admin.232")}
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {page} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {tr("admin.233")}
          </Button>
        </div>
      )}
    </motion.div>
  );
}
