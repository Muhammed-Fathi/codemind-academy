"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { CodeMindLogo } from "@/components/logo";
import { brand } from "@/lib/brand";
import { toast } from "sonner";
import {
  X,
  Printer,
  TrendingUp,
  TrendingDown,
  CheckCircle2,
  AlertTriangle,
  Calendar,
  User,
  Award,
} from "lucide-react";

type ReportData = {
  studentName: string;
  studentEmail: string;
  grade: string;
  courseName: string;
  groupName: string;
  reportMonth: string;
  generatedAt: string;
  // stats
  courseProgress: { completed: number; total: number; pct: number };
  attendance: { pct: number; present: number; total: number };
  quizzes: { average: number; taken: number; passed: number; failed: number };
  homework: { submitted: number; graded: number; completionPct: number };
  subscription: { status: string; planName: string; daysLeft: number };
  strongTopics: { title: string; avgPct: number }[];
  weakTopics: { title: string; avgPct: number }[];
  recentQuizzes: { title: string; percentage: number; passed: boolean; date: string }[];
  teacherNotes: { teacherName: string; note: string; date: string }[];
  recommendations: string[];
};

export function MonthlyReportView({ onClose }: { onClose: () => void }) {
  const [data, setData] = React.useState<ReportData | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch("/api/parents/me/dashboard")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.children?.[0]) {
          const child = d.children[0];
          const monthName = new Date().toLocaleDateString("ar-EG", {
            month: "long",
            year: "numeric",
          });
          setData({
            studentName: child.name,
            studentEmail: child.email,
            grade: child.grade || "2nd Secondary",
            courseName: child.group?.course?.nameAr || "Programming & AI",
            groupName: child.group?.name || "—",
            reportMonth: monthName,
            generatedAt: new Date().toLocaleDateString("ar-EG"),
            courseProgress: child.courseProgress,
            attendance: child.attendance,
            quizzes: child.quizzes,
            homework: child.homework,
            subscription: child.subscription,
            strongTopics: child.strongTopics || [],
            weakTopics: child.weakTopics || [],
            recentQuizzes: (child.quizzes?.recent || []).slice(0, 5).map((q: any) => ({
              title: q.quizTitle,
              percentage: q.percentage,
              passed: q.passed,
              date: new Date(q.finishedAt).toLocaleDateString("ar-EG"),
            })),
            teacherNotes: (child.teacherNotes || []).slice(0, 3).map((n: any) => ({
              teacherName: n.teacherName,
              note: n.note,
              date: new Date(n.createdAt).toLocaleDateString("ar-EG"),
            })),
            recommendations: generateRecommendations(child),
          });
        }
      })
      .catch(() => toast.error("حصلت مشكلة في تحميل البيانات"))
      .finally(() => setLoading(false));
  }, []);

  const handlePrint = () => {
    window.print();
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="text-sm text-muted-foreground">جارٍ تجهيز التقرير…</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">مفيش بيانات متاحة للتقرير</p>
          <Button variant="outline" className="mt-4" onClick={onClose}>
            رجوع
          </Button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Print-specific styles */}
      <style jsx global>{`
        @media print {
          body * { visibility: hidden; }
          .print-report, .print-report * { visibility: visible; }
          .print-report { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
          @page { margin: 1.5cm; }
        }
      `}</style>

      {/* Toolbar (not printed) */}
      <div className="no-print fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-start justify-center p-4 sm:p-6 overflow-y-auto">
        <div className="w-full max-w-4xl my-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold">Monthly Report — {data.studentName}</h2>
            <div className="flex items-center gap-2">
              <Button onClick={handlePrint} className="font-bold">
                <Printer className="w-4 h-4 ml-2" />
                حفظ كـ PDF
              </Button>
              <Button variant="outline" onClick={onClose}>
                <X className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {/* Report content (also printed) */}
          <div className="print-report bg-white text-black rounded-2xl shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="bg-gradient-to-br from-emerald-600 via-teal-600 to-amber-500 text-white p-8">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-extrabold">{brand.name}</div>
                  <div className="text-sm opacity-90">{brand.tagline}</div>
                </div>
                <CodeMindLogo size={48} />
              </div>
              <div className="mt-6 pt-6 border-t border-white/20">
                <div className="text-xs opacity-75 uppercase tracking-wider">Monthly Report</div>
                <div className="text-3xl font-extrabold mt-1">{data.reportMonth}</div>
              </div>
            </div>

            {/* Student info */}
            <div className="p-8 border-b border-gray-200">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <InfoField label="الطالب" value={data.studentName} />
                <InfoField label="الصف" value={data.grade} />
                <InfoField label="الكورس" value={data.courseName} />
                <InfoField label="المجموعة" value={data.groupName} />
              </div>
            </div>

            {/* Performance overview */}
            <div className="p-8">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-emerald-600" />
                نظرة عامة على الأداء
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <MetricCard label="Course Progress" value={`${data.courseProgress.pct}%`} sub={`${data.courseProgress.completed}/${data.courseProgress.total} Lessons`} tone="emerald" />
                <MetricCard label="Attendance" value={`${data.attendance.pct}%`} sub={`${data.attendance.present}/${data.attendance.total} Sessions`} tone="teal" />
                <MetricCard label="Quiz Average" value={`${data.quizzes.average}%`} sub={`${data.quizzes.passed} نجح`} tone="amber" />
                <MetricCard label="Homework" value={`${data.homework.completionPct}%`} sub={`${data.homework.submitted} submitted`} tone="orange" />
              </div>
            </div>

            {/* Subscription status */}
            <div className="px-8 pb-6">
              <div className="bg-gray-50 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <div className="text-xs text-gray-500">Subscription Status</div>
                  <div className="text-sm font-bold mt-1">
                    {data.subscription.status === "ACTIVE" ? "Active" : data.subscription.status}
                    {data.subscription.planName && ` · ${data.subscription.planName}`}
                  </div>
                </div>
                <div className="text-left">
                  <div className="text-xs text-gray-500">الأيام المتبقية</div>
                  <div className="text-lg font-bold text-emerald-600">{data.subscription.daysLeft}</div>
                </div>
              </div>
            </div>

            {/* Strong / Weak topics */}
            <div className="p-8 border-t border-gray-200">
              <div className="grid sm:grid-cols-2 gap-6">
                <div>
                  <h4 className="text-sm font-bold mb-3 flex items-center gap-2 text-emerald-700">
                    <CheckCircle2 className="w-4 h-4" />
                    Strong Topics
                  </h4>
                  {data.strongTopics.length === 0 ? (
                    <p className="text-xs text-gray-400">مفيش بيانات كفاية</p>
                  ) : (
                    <ul className="space-y-2">
                      {data.strongTopics.map((t, i) => (
                        <li key={i} className="flex items-center justify-between text-sm">
                          <span>{t.title}</span>
                          <span className="font-bold text-emerald-600">{t.avgPct}%</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h4 className="text-sm font-bold mb-3 flex items-center gap-2 text-amber-700">
                    <AlertTriangle className="w-4 h-4" />
                    Weak Topics — محتاجة تركيز
                  </h4>
                  {data.weakTopics.length === 0 ? (
                    <p className="text-xs text-gray-400">مفيش بيانات كفاية</p>
                  ) : (
                    <ul className="space-y-2">
                      {data.weakTopics.map((t, i) => (
                        <li key={i} className="flex items-center justify-between text-sm">
                          <span>{t.title}</span>
                          <span className="font-bold text-amber-600">{t.avgPct}%</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            {/* Recent quizzes */}
            {data.recentQuizzes.length > 0 && (
              <div className="p-8 border-t border-gray-200">
                <h4 className="text-sm font-bold mb-3">آخر Quizzes</h4>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-200">
                      <th className="pb-2">الـQuiz</th>
                      <th className="pb-2 text-center">النسبة</th>
                      <th className="pb-2 text-center">النتيجة</th>
                      <th className="pb-2 text-left">التاريخ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentQuizzes.map((q, i) => (
                      <tr key={i} className="border-b border-gray-100">
                        <td className="py-2">{q.title}</td>
                        <td className="py-2 text-center font-bold">{q.percentage}%</td>
                        <td className="py-2 text-center">
                          {q.passed ? (
                            <span className="text-emerald-600 font-bold">نجح</span>
                          ) : (
                            <span className="text-amber-600 font-bold">مكملة</span>
                          )}
                        </td>
                        <td className="py-2 text-left text-gray-500">{q.date}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Teacher notes */}
            {data.teacherNotes.length > 0 && (
              <div className="p-8 border-t border-gray-200">
                <h4 className="text-sm font-bold mb-3 flex items-center gap-2">
                  <User className="w-4 h-4" />
                  ملاحظات المعلم
                </h4>
                <ul className="space-y-3">
                  {data.teacherNotes.map((n, i) => (
                    <li key={i} className="text-sm bg-gray-50 rounded-lg p-3">
                      <div className="text-xs text-gray-500 mb-1">{n.teacherName} · {n.date}</div>
                      <div>{n.note}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Recommendations */}
            <div className="p-8 border-t border-gray-200 bg-gradient-to-br from-emerald-50 to-amber-50">
              <h4 className="text-sm font-bold mb-3 flex items-center gap-2">
                <Award className="w-4 h-4 text-amber-600" />
                توصيات وخطوات قادمة
              </h4>
              <ul className="space-y-2">
                {data.recommendations.map((r, i) => (
                  <li key={i} className="text-sm flex items-start gap-2">
                    <span className="text-emerald-600 font-bold mt-0.5">{i + 1}.</span>
                    <span>{r}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Footer */}
            <div className="p-6 bg-gray-900 text-white text-center text-xs">
              <div className="font-bold mb-1">{brand.name}</div>
              <div className="opacity-75">
                تم إنشاء هذا التقرير في {data.generatedAt} · {brand.academicYear}
              </div>
              <div className="opacity-50 mt-2">
                CodeMind Academy · Learn. Build. Think.
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
      <div className="text-sm font-bold mt-1">{value}</div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "emerald" | "teal" | "amber" | "orange";
}) {
  const colors = {
    emerald: "text-emerald-600",
    teal: "text-teal-600",
    amber: "text-amber-600",
    orange: "text-orange-600",
  };
  return (
    <div className="bg-gray-50 rounded-xl p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-extrabold mt-1 ${colors[tone]}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{sub}</div>
    </div>
  );
}

function generateRecommendations(child: any): string[] {
  const recs: string[] = [];
  if (child.courseProgress?.pct < 30) {
    recs.push("الطالب محتاج يكمل Lessons أكتر — خلّي يداوم على Lesson يومياً.");
  } else if (child.courseProgress?.pct < 60) {
    recs.push("التقدم حلو، بس محتاج استمرارية في حل Lessons.");
  } else {
    recs.push("التقدم ممتاز! خلّي الطالب يبدأ مراجعة الـLessons اللي فاتت.");
  }
  if (child.attendance?.pct < 75) {
    recs.push("Attendance منخفض — لازم نأكد على الطالب بحضور Live Sessions.");
  }
  if (child.quizzes?.average < 60) {
    recs.push("متوسط Quizzes منخفض — يحتاج مراجعة المواضيع اللي ضعيف فيها.");
  } else if (child.quizzes?.average >= 85) {
    recs.push("أداء Quizzes ممتاز — تشجيع على التحدي بمواضيع أصعب.");
  }
  if (child.homework?.completionPct < 50) {
    recs.push("Homework مش بيتسلم بانتظام — متابعة أقرب من الأهل.");
  }
  if (recs.length === 0) {
    recs.push("الأداء العام جيد، استمر على نفس الوتيرة.");
  }
  return recs;
}
