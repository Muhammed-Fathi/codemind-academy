"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  Clock,
  Timer,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Trophy,
  Sparkles,
  Loader2,
} from "lucide-react";

type Question = {
  id: string;
  type: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string | null;
  difficulty: string;
  marks: number;
  source: string;
  lessonTitle: string;
};

type ExamData = {
  examType: string;
  questionCount: number;
  durationMin: number;
  totalMarks: number;
  questions: Question[];
};

type Phase = "setup" | "exam" | "result";

export function MockExamRunner() {
  const setView = useApp((s) => s.setView);
  const [phase, setPhase] = React.useState<Phase>("setup");
  const [exam, setExam] = React.useState<ExamData | null>(null);
  const [current, setCurrent] = React.useState(0);
  const [answers, setAnswers] = React.useState<Record<string, number>>({});
  const [timeLeft, setTimeLeft] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<any>(null);

  const startExam = async (count: number, difficulty: string) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/exams/mock?count=${count}&difficulty=${difficulty}`);
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || "مفيش أسئلة متاحة");
        return;
      }
      if (!d.exam) {
        toast.error(d.message || "مفيش أسئلة في الـQuestion Bank");
        return;
      }
      setExam(d.exam);
      setAnswers({});
      setCurrent(0);
      setTimeLeft(d.exam.durationMin * 60);
      setPhase("exam");
      toast.success(`بدأ الـMock Exam! ${d.exam.questions.length} سؤال في ${d.exam.durationMin} دقيقة`);
    } catch {
      toast.error("حصلت مشكلة في تحميل الامتحان");
    } finally {
      setLoading(false);
    }
  };

  // Countdown timer
  React.useEffect(() => {
    if (phase !== "exam") return;
    if (timeLeft <= 0) {
      submitExam();
      return;
    }
    const t = setInterval(() => setTimeLeft((s) => s - 1), 1000);
    return () => clearInterval(t);
  }, [phase, timeLeft]);

  const submitExam = async () => {
    if (!exam) return;
    setLoading(true);
    try {
      const graded = exam.questions.map((q) => {
        const selected = answers[q.id];
        const isCorrect = selected === q.correctIndex;
        return {
          questionId: q.id,
          selected: String(selected ?? -1),
          isCorrect,
          marks: isCorrect ? q.marks : 0,
        };
      });
      const r = await fetch("/api/exams/mock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examType: exam.examType,
          durationMin: exam.durationMin,
          answers: graded,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || "فشل حفظ النتيجة");
        return;
      }
      setResult({ ...d.attempt, questions: exam.questions, answers });
      setPhase("result");
      if (d.attempt.percentage >= 60) {
        toast.success(`نجحت! ${d.attempt.percentage}% 🎉`);
      } else {
        toast.info(`النتيجة: ${d.attempt.percentage}% — حاول تاني`);
      }
    } catch {
      toast.error("حصلت مشكلة في حفظ النتيجة");
    } finally {
      setLoading(false);
    }
  };

  // ---------- Setup Phase ----------
  if (phase === "setup") {
    return (
      <div className="space-y-4">
        <button
          onClick={() => setView("student-dashboard")}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ChevronRight className="w-4 h-4" />
          رجوع للـDashboard
        </button>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="glass card-hover overflow-hidden relative">
            <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-l from-amber-500 via-teal-500 to-emerald-500" />
            <CardHeader>
              <div className="flex items-center gap-2.5">
                <div className="grid place-items-center w-11 h-11 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-lg">
                  <Timer className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-xl">Mock Exam Mode</CardTitle>
                  <CardDescription>
                    امتحان تجريبي بأسئلة عشوائية من الـQuestion Bank — مع مؤقت وتصحيص فوري
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div>
                <div className="text-sm font-bold mb-2">اختار عدد الأسئلة</div>
                <div className="grid grid-cols-3 gap-2">
                  {[5, 10, 15].map((n) => (
                    <button
                      key={n}
                      onClick={() => startExam(n, "mixed")}
                      disabled={loading}
                      className="rounded-xl border-2 border-border bg-card p-4 hover:border-primary/40 hover:bg-primary/5 transition-all text-center group"
                    >
                      <div className="text-2xl font-extrabold text-gradient group-hover:scale-110 transition-transform">
                        {n}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">أسئلة</div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-sm font-bold mb-2">حسب الصعوبة</div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { key: "EASY", label: "سهل", color: "from-emerald-400 to-teal-500" },
                    { key: "MEDIUM", label: "متوسط", color: "from-amber-400 to-orange-500" },
                    { key: "HARD", label: "صعب", color: "from-rose-400 to-red-500" },
                  ].map((d) => (
                    <button
                      key={d.key}
                      onClick={() => startExam(10, d.key)}
                      disabled={loading}
                      className={`rounded-xl bg-gradient-to-br ${d.color} text-white p-4 text-center font-bold hover:opacity-90 transition-opacity disabled:opacity-50`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              {loading && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  جارٍ تجهيز الأسئلة...
                </div>
              )}
              <div className="rounded-xl bg-muted/40 border border-border/40 p-4 text-xs text-muted-foreground leading-relaxed">
                <Sparkles className="w-4 h-4 text-amber-500 inline ml-1" />
                الأسئلة بتتجاب بشكل عشوائي من كل الـLessons. كل امتحان بيختلف عن اللي قبله.
                المؤقت بيبدأ أول ما تضغط، والنتيجة بتتحفظ تلقائيًا.
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  // ---------- Exam Phase ----------
  if (phase === "exam" && exam) {
    const q = exam.questions[current];
    const answered = Object.keys(answers).length;
    const progress = (answered / exam.questions.length) * 100;
    const min = Math.floor(timeLeft / 60);
    const sec = timeLeft % 60;
    const timeWarning = timeLeft < 60;

    return (
      <div className="space-y-4">
        {/* Top bar: timer + progress */}
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={() => {
              if (confirm("متأكد تخرج من الامتحان؟ النتيجة مش هتتحفظ.")) {
                setPhase("setup");
                setExam(null);
              }
            }}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ChevronRight className="w-4 h-4" />
            خروج
          </button>
          <div className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold text-sm ${
            timeWarning ? "bg-destructive/15 text-destructive animate-pulse" : "bg-primary/10 text-primary"
          }`}>
            <Clock className="w-4 h-4" />
            {String(min).padStart(2, "0")}:{String(sec).padStart(2, "0")}
          </div>
        </div>

        <Progress value={progress} className="h-2" />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>اتجاوب: {answered} / {exam.questions.length}</span>
          <span>سؤال {current + 1} من {exam.questions.length}</span>
        </div>

        {/* Question card */}
        <AnimatePresence mode="wait">
          <motion.div
            key={current}
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -30 }}
            transition={{ duration: 0.25 }}
          >
            <Card className="glass card-hover">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={
                      q.difficulty === "EASY" ? "border-emerald-400/40 text-emerald-600" :
                      q.difficulty === "MEDIUM" ? "border-amber-400/40 text-amber-600" :
                      "border-rose-400/40 text-rose-600"
                    }>
                      {q.difficulty === "EASY" ? "سهل" : q.difficulty === "MEDIUM" ? "متوسط" : "صعب"}
                    </Badge>
                    <Badge variant="outline" className="text-muted-foreground">
                      {q.marks} marks
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {q.lessonTitle}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-lg font-bold leading-relaxed mb-5">
                  {q.prompt}
                </div>
                <div className="space-y-2.5">
                  {q.options.map((opt, i) => {
                    const selected = answers[q.id] === i;
                    return (
                      <button
                        key={i}
                        onClick={() => setAnswers((a) => ({ ...a, [q.id]: i }))}
                        className={`w-full text-right p-3.5 rounded-xl border-2 transition-all flex items-center gap-3 ${
                          selected
                            ? "border-primary bg-primary/10 shadow-sm"
                            : "border-border bg-card hover:border-primary/40"
                        }`}
                      >
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold shrink-0 transition-colors ${
                          selected
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground"
                        }`}>
                          {String.fromCharCode(65 + i)}
                        </div>
                        <span className="flex-1 text-sm">{opt}</span>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </AnimatePresence>

        {/* Navigation */}
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
            disabled={current === 0}
          >
            <ChevronRight className="w-4 h-4 ml-1" />
            السابق
          </Button>
          {/* Question dots */}
          <div className="flex gap-1.5 flex-1 justify-center overflow-x-auto scrollbar-hide">
            {exam.questions.map((qq, i) => (
              <button
                key={qq.id}
                onClick={() => setCurrent(i)}
                className={`w-7 h-7 rounded-full text-[10px] font-bold shrink-0 transition-all ${
                  i === current
                    ? "bg-primary text-primary-foreground ring-2 ring-primary/30 scale-110"
                    : answers[qq.id] !== undefined
                    ? "bg-primary/20 text-primary"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {i + 1}
              </button>
            ))}
          </div>
          {current < exam.questions.length - 1 ? (
            <Button onClick={() => setCurrent((c) => c + 1)}>
              التالي
              <ChevronLeft className="w-4 h-4 mr-1" />
            </Button>
          ) : (
            <Button
              onClick={submitExam}
              disabled={loading}
              className="bg-gradient-to-r from-emerald-500 to-teal-500"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "تسليم"}
            </Button>
          )}
        </div>
      </div>
    );
  }

  // ---------- Result Phase ----------
  if (phase === "result" && result && exam) {
    return (
      <div className="space-y-5">
        <button
          onClick={() => {
            setPhase("setup");
            setResult(null);
            setExam(null);
          }}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ChevronRight className="w-4 h-4" />
          امتحان تاني
        </button>

        {/* Score hero */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 200 }}
        >
          <Card className={`glass overflow-hidden relative ${
            result.passed ? "border-emerald-400/30" : "border-amber-400/30"
          }`}>
            <div className={`h-2 ${result.passed ? "bg-gradient-to-r from-emerald-500 to-teal-500" : "bg-gradient-to-r from-amber-500 to-orange-500"}`} />
            <CardContent className="p-8 text-center">
              <div className={`w-20 h-20 mx-auto rounded-full flex items-center justify-center mb-4 ${
                result.passed
                  ? "bg-gradient-to-br from-emerald-400 to-teal-500"
                  : "bg-gradient-to-br from-amber-400 to-orange-500"
              }`}>
                {result.passed ? (
                  <Trophy className="w-10 h-10 text-white" />
                ) : (
                  <RotateCcw className="w-10 h-10 text-white" />
                )}
              </div>
              <div className="text-5xl font-extrabold text-gradient mb-2">
                {result.percentage}%
              </div>
              <div className="text-lg font-bold">
                {result.passed ? "نجحت! 🎉" : "مكملة — حاول تاني"}
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                {result.score} / {result.totalMarks} marks · {exam.questions.length} سؤال
              </p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Answer review */}
        <div className="space-y-3">
          <h3 className="text-lg font-bold">مراجعة الإجابات</h3>
          {exam.questions.map((q, i) => {
            const userAnswer = result.answers[q.id];
            const correct = userAnswer === q.correctIndex;
            return (
              <motion.div
                key={q.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <Card className={`glass border ${correct ? "border-emerald-400/30" : "border-rose-400/30"}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
                        correct ? "bg-emerald-500 text-white" : "bg-rose-500 text-white"
                      }`}>
                        {correct ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold mb-2">
                          {i + 1}. {q.prompt}
                        </div>
                        <div className="space-y-1.5 text-xs">
                          {q.options.map((opt, j) => {
                            const isCorrect = j === q.correctIndex;
                            const isUser = j === userAnswer;
                            return (
                              <div
                                key={j}
                                className={`flex items-center gap-2 p-2 rounded-lg ${
                                  isCorrect
                                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 font-bold"
                                    : isUser
                                    ? "bg-rose-500/10 text-rose-700 dark:text-rose-400"
                                    : "text-muted-foreground"
                                }`}
                              >
                                <span className="font-bold">{String.fromCharCode(65 + j)}.</span>
                                <span className="flex-1">{opt}</span>
                                {isCorrect && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                                {isUser && !isCorrect && <XCircle className="w-3.5 h-3.5 text-rose-500" />}
                              </div>
                            );
                          })}
                        </div>
                        {q.explanation && (
                          <div className="mt-2 p-2.5 rounded-lg bg-muted/40 text-xs text-muted-foreground">
                            <Sparkles className="w-3 h-3 ml-1 inline text-amber-500" />
                            {q.explanation}
                          </div>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      </div>
    );
  }

  return null;
}
