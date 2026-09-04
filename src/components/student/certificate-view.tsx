"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion } from "framer-motion";
import { useApp } from "@/lib/store";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Award,
  Printer,
  ChevronLeft,
  Sparkles,
  ShieldCheck,
  TrendingUp,
  Calendar,
  BookOpen,
} from "lucide-react";
import { CodeMindLogo } from "@/components/logo";

type Certificate = {
  studentName: string;
  courseName: string;
  courseSlug: string;
  completionDate: string;
  academicYear: string;
  academyName: string;
  tagline: string;
  avgQuizScore: number;
  attendanceRate: number;
  certificateId: string;
};

export function CertificateView() {
  const t = useT();
  const setView = useApp((s) => s.setView);
  const [cert, setCert] = React.useState<Certificate | null>(null);
  const [eligible, setEligible] = React.useState(false);
  const [progressPct, setProgressPct] = React.useState(0);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch("/api/students/me/certificate")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setEligible(d.eligible);
          setProgressPct(d.progressPct);
          if (d.certificate) setCert(d.certificate);
        }
      })
      .catch(() => toast.error(t("student.019")))
      .finally(() => setLoading(false));
  }, []);

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-96 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <>
      <style jsx global>{`
        @media print {
          body * { visibility: hidden; }
          .print-cert, .print-cert * { visibility: visible; }
          .print-cert { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
          @page { margin: 1cm; size: landscape; }
        }
      `}</style>

      <div className="space-y-4">
        <button
          onClick={() => setView("student-dashboard")}
          className="no-print text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ChevronLeft className="w-4 h-4 flip-rtl" />
          {t("student.020")}</button>

        {eligible && cert ? (
          <>
            <div className="no-print flex items-center justify-between mb-2">
              <h2 className="text-lg font-bold">{t("student.021")}</h2>
              <Button onClick={handlePrint} className="font-bold">
                <Printer className="w-4 h-4 ms-2" />
                {t("student.022")}</Button>
            </div>

            {/* Certificate (also printed) */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ type: "spring", stiffness: 200 }}
              className="print-cert"
            >
              <div className="bg-white text-black rounded-3xl shadow-2xl overflow-hidden relative">
                {/* Decorative border */}
                <div className="absolute inset-3 border-4 border-double border-emerald-600/30 rounded-2xl pointer-events-none" />

                {/* Top gradient strip */}
                <div className="h-3 bg-gradient-to-r from-emerald-600 via-teal-500 to-amber-500" />

                <div className="p-10 sm:p-14 relative">
                  {/* Decorative corner sparkles */}
                  <Sparkles className="absolute top-6 end-6 w-6 h-6 text-amber-400/50" />
                  <Sparkles className="absolute bottom-6 start-6 w-6 h-6 text-amber-400/50" />

                  {/* Header */}
                  <div className="flex items-center justify-between mb-8">
                    <div>
                      <div className="text-3xl font-extrabold text-emerald-700">
                        {cert.academyName}
                      </div>
                      <div className="text-sm text-gray-500 mt-1">
                        {cert.tagline}
                      </div>
                    </div>
                    <CodeMindLogo size={64} />
                  </div>

                  {/* Title */}
                  <div className="text-center mb-10">
                    <div className="inline-flex items-center gap-2 text-amber-600 text-xs font-bold uppercase tracking-wider mb-2">
                      <Award className="w-4 h-4" />
                      Certificate of Completion
                    </div>
                    <h1 className="text-4xl sm:text-5xl font-extrabold text-gray-900">
                      {t("student.023")}</h1>
                    <div className="mt-4 text-lg text-gray-700">
                      {t("student.024")}</div>
                    <div className="text-3xl sm:text-4xl font-extrabold mt-3 text-emerald-700">
                      {cert.studentName}
                    </div>
                    <div className="mt-3 text-gray-600">
                      {t("student.025")}</div>
                    <div className="text-2xl font-bold mt-2 text-teal-700">
                      {cert.courseName}
                    </div>
                  </div>

                  {/* Stats strip */}
                  <div className="grid grid-cols-3 gap-4 mb-10 max-w-2xl mx-auto">
                    <div className="text-center">
                      <div className="flex items-center justify-center w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 mx-auto mb-2">
                        <TrendingUp className="w-5 h-5" />
                      </div>
                      <div className="text-2xl font-bold text-gray-900">
                        {cert.avgQuizScore}%
                      </div>
                      <div className="text-xs text-gray-500">{t("student.026")}</div>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center w-12 h-12 rounded-full bg-teal-100 text-teal-600 mx-auto mb-2">
                        <ShieldCheck className="w-5 h-5" />
                      </div>
                      <div className="text-2xl font-bold text-gray-900">
                        {cert.attendanceRate}%
                      </div>
                      <div className="text-xs text-gray-500">Attendance</div>
                    </div>
                    <div className="text-center">
                      <div className="flex items-center justify-center w-12 h-12 rounded-full bg-amber-100 text-amber-600 mx-auto mb-2">
                        <Calendar className="w-5 h-5" />
                      </div>
                      <div className="text-xs font-bold text-gray-700 mt-2">
                        {cert.completionDate}
                      </div>
                      <div className="text-xs text-gray-500">{t("student.027")}</div>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="flex items-end justify-between border-t-2 border-emerald-600/20 pt-6">
                    <div>
                      <div className="text-xs text-gray-500 mb-1">Certificate ID</div>
                      <div className="font-mono text-xs font-bold text-gray-700">
                        {cert.certificateId}
                      </div>
                    </div>
                    <div className="text-center">
                      <div className="w-40 border-b-2 border-gray-400 mb-1" />
                      <div className="text-xs text-gray-600 font-semibold">
                        CodeMind Academy
                      </div>
                      <div className="text-xs text-gray-400 mt-0.5">
                        Academic Year {cert.academicYear}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </>
        ) : (
          /* Not eligible view */
          <Card className="glass card-hover">
            <CardContent className="p-10 text-center">
              <div className="w-16 h-16 rounded-2xl bg-amber-400/15 flex items-center justify-center mx-auto mb-4">
                <Award className="w-8 h-8 text-amber-500" />
              </div>
              <h2 className="text-xl font-bold">{t("student.028")}</h2>
              <p className="text-sm text-muted-foreground mt-2 max-w-md mx-auto">
                {t("student.029")}</p>
              <div className="mt-6 max-w-xs mx-auto">
                <div className="flex items-center justify-between text-xs mb-2">
                  <span className="text-muted-foreground">{t("student.030")}</span>
                  <span className="font-bold text-amber-600">{progressPct}%</span>
                </div>
                <div className="h-3 bg-muted rounded-full overflow-hidden">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${progressPct}%` }}
                    transition={{ duration: 0.8 }}
                    className="h-full bg-gradient-to-r from-emerald-500 to-teal-500 rounded-full"
                  />
                </div>
                <div className="text-xs text-muted-foreground mt-2">
                  {t("student.031")}{Math.max(0, 80 - progressPct)}{t("student.032")}</div>
              </div>
              <Button
                className="mt-6"
                onClick={() => setView("student-course")}
              >
                <BookOpen className="w-4 h-4 ms-2" />
                {t("student.033")}</Button>
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}

