"use client";
import { useT , pickAuto } from "@/lib/i18n";

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
  difficulty: string;
  marks: number;
  source: string;
  lessonTitle: string;
};

// Post-submit review row from the server. Correctness is server truth — the
// served exam draft carries no answer key, so the client cannot grade.
type ReviewRow = {
  questionId: string;
  selected: string;
  isCorrect: boolean;
  marks: number;
  correctText: string | null;
  explanation: string | null;
};

type ExamData = {
  mockExamId: string | null;
  examType: string;
  questionCount: number;
  durationMin: number;
  totalMarks: number;
  questions: Question[];
};

type AssignedExam = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  questionCount: number;
  durationMin: number;
  passMark: number;
  difficulty: string;
  selectionMode: string;
  attempts: number;
  bestPercentage: number | null;
};

type Phase = "setup" | "exam" | "result";

export function MockExamRunner() {
  const tr = useT();
  const setView = useApp((s) => s.setView);
  const [phase, setPhase] = React.useState<Phase>("setup");
  const [exam, setExam] = React.useState<ExamData | null>(null);
  const [current, setCurrent] = React.useState(0);
  const [answers, setAnswers] = React.useState<Record<string, number>>({});
  const [timeLeft, setTimeLeft] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<any>(null);
  const [assigned, setAssigned] = React.useState<AssignedExam[] | null>(null);

  // Admin-published exams this student is eligible for (same bank + course).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/students/me/mock-exams");
        const d = await r.json().catch(() => ({}));
        if (!cancelled && r.ok) setAssigned(d.exams || []);
      } catch {
        if (!cancelled) setAssigned([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startExam = async (count: number, difficulty: string, mockExamId?: string) => {
    setLoading(true);
    try {
      const qs = mockExamId
        ? `mockExamId=${encodeURIComponent(mockExamId)}`
        : `count=${count}&difficulty=${difficulty}`;
      const r = await fetch(`/api/exams/mock?${qs}`);
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || tr("student.049"));
        return;
      }
      if (!d.exam) {
        toast.error(d.message || tr("student.050"));
        return;
      }
      setExam(d.exam);
      setAnswers({});
      setCurrent(0);
      setTimeLeft(d.exam.durationMin * 60);
      setPhase("exam");
      toast.success(tr("student.051", { p1: d.exam.questions.length, p2: d.exam.durationMin }));
    } catch {
      toast.error(tr("student.052"));
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
        return {
          questionId: q.id,
          // The server shuffles display order per request, so an option INDEX
          // is meaningless to the grader — report the selected option TEXT
          // (server contract). isCorrect/marks are placeholders the server
          // always recomputes; they are never trusted.
          selected: selected !== undefined ? q.options[selected] ?? "-1" : "-1",
          isCorrect: false,
          marks: 0,
        };
      });
      const r = await fetch("/api/exams/mock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          examType: exam.examType,
          durationMin: exam.durationMin,
          mockExamId: exam.mockExamId,
          answers: graded,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || tr("student.053"));
        return;
      }
      const reviewById: Record<string, ReviewRow> = {};
      for (const row of d.review || []) reviewById[row.questionId] = row;
      setResult({ ...d.attempt, questions: exam.questions, answers, review: reviewById });
      setPhase("result");
      if (d.attempt.percentage >= 60) {
        toast.success(tr("student.054", { p1: d.attempt.percentage }));
      } else {
        toast.info(tr("student.055", { p1: d.attempt.percentage }));
      }
    } catch {
      toast.error(tr("student.056"));
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
          {tr("student.057")}</button>
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
                    {tr("student.058")}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {assigned !== null && (
                <div>
                  <div className="text-sm font-bold mb-2">{tr("student.234")}</div>
                  {assigned.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                      {tr("student.238")}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {assigned.map((e) => (
                        <div
                          key={e.id}
                          className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">
                              {pickAuto(e.titleAr, e.title)}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                              <span>
                                {e.questionCount} {tr("student.060")}
                              </span>
                              <span>· {e.durationMin} {tr("student.230")}</span>
                              <span>· {e.attempts} {tr("student.237")}</span>
                              {e.bestPercentage !== null && (
                                <span>
                                  · {tr("student.236")}: {e.bestPercentage}%
                                </span>
                              )}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => startExam(e.questionCount, e.difficulty, e.id)}
                            disabled={loading}
                          >
                            {tr("student.235")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div>
                <div className="text-sm font-bold mb-2">{tr("student.059")}</div>
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
                      <div className="text-xs text-muted-foreground mt-0.5">{tr("student.060")}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-sm font-bold mb-2">{tr("student.061")}</div>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { key: "EASY", label: tr("student.062"), color: "from-emerald-400 to-teal-500" },
                    { key: "MEDIUM", label: tr("student.063"), color: "from-amber-400 to-orange-500" },
                    { key: "HARD", label: tr("student.064"), color: "from-rose-400 to-red-500" },
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
                  {tr("student.065")}</div>
              )}
              <div className="rounded-xl bg-muted/40 border border-border/40 p-4 text-xs text-muted-foreground leading-relaxed">
                <Sparkles className="w-4 h-4 text-amber-500 inline ms-1" />
                {tr("student.066")}</div>
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
              if (confirm(tr("student.067"))) {
                setPhase("setup");
                setExam(null);
              }
            }}
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ChevronRight className="w-4 h-4" />
            {tr("student.068")}</button>
          <div className={`flex items-center gap-2 px-4 py-2 rounded-full font-bold text-sm ${
            timeWarning ? "bg-destructive/15 text-destructive animate-pulse" : "bg-primary/10 text-primary"
          }`}>
            <Clock className="w-4 h-4" />
            {String(min).padStart(2, "0")}:{String(sec).padStart(2, "0")}
          </div>
        </div>

        <Progress value={progress} className="h-2" />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{tr("student.069")}{answered} / {exam.questions.length}</span>
          <span>{tr("student.070")}{current + 1} {tr("student.071")}{exam.questions.length}</span>
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
                      {q.difficulty === "EASY" ? tr("student.062") : q.difficulty === "MEDIUM" ? tr("student.063") : tr("student.064")}
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
                        className={`w-full text-end p-3.5 rounded-xl border-2 transition-all flex items-center gap-3 ${
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
            <ChevronRight className="w-4 h-4 ms-1" />
            {tr("student.075")}</Button>
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
              {tr("student.076")}<ChevronLeft className="w-4 h-4 me-1" />
            </Button>
          ) : (
            <Button
              onClick={submitExam}
              disabled={loading}
              className="bg-gradient-to-r from-emerald-500 to-teal-500"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : tr("student.077")}
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
          {tr("student.078")}</button>

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
                {result.passed ? tr("student.079") : tr("student.080")}
              </div>
              <p className="text-sm text-muted-foreground mt-2">
                {result.score} / {result.totalMarks} marks · {exam.questions.length} {tr("student.070")}</p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Answer review */}
        <div className="space-y-3">
          <h3 className="text-lg font-bold">{tr("student.082")}</h3>
          {exam.questions.map((q, i) => {
            const rev: ReviewRow | undefined = result.review?.[q.id];
            const userAnswer = result.answers[q.id];
            // Server truth: the draft carried no key, so only the POST review
            // knows correctness. The correct option is matched by TEXT because
            // display order was shuffled per request.
            const correct = rev?.isCorrect === true;
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
                            const isCorrect = rev?.correctText !== null && rev?.correctText !== undefined && opt === rev.correctText;
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
                        {rev?.explanation && (
                          <div className="mt-2 p-2.5 rounded-lg bg-muted/40 text-xs text-muted-foreground">
                            <Sparkles className="w-3 h-3 ms-1 inline text-amber-500" />
                            {rev.explanation}
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
