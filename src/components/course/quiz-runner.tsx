"use client";
import { useT , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useApp } from "@/lib/store";
import { toast } from "sonner";
import {
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Trophy,
  RotateCw,
  Sparkles,
  Lightbulb,
  ListChecks,
} from "lucide-react";
import {
  QuizCameraConsent,
  QuizCameraMonitor,
} from "@/components/course/quiz-camera-monitor";

// ============================================================
// Types
// ============================================================
type Question = {
  id: string;
  type: "MCQ" | "TRUE_FALSE";
  prompt: string;
  promptAr: string | null;
  options: string[];
  answer: string;
  explanation: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
};

type QuizData = {
  quiz: {
    id: string;
    title: string;
    titleAr: string;
    description: string | null;
    passMark: number;
    timeLimit: number | null;
  };
  lesson: {
    id: string;
    title: string;
    titleAr: string;
    courseSlug: string;
  } | null;
  questions: Question[];
  bestAttempt: {
    id: string;
    score: number;
    totalMarks: number;
    percentage: number;
    passed: boolean;
    finishedAt: string | null;
  } | null;
};

type GradedAnswer = {
  questionId: string;
  prompt: string;
  promptAr: string | null;
  selected: string;
  correctAnswer: string;
  isCorrect: boolean;
  marks: number;
  options: string[];
  explanation: string | null;
};

type SubmitResult = {
  attemptId: string;
  score: number;
  totalMarks: number;
  percentage: number;
  passed: boolean;
  passMark: number;
  answers: GradedAnswer[];
};

// ============================================================
// Main
// ============================================================
export function QuizRunner() {
  const t = useT();
  const setView = useApp((s) => s.setView);
  const setNavParam = useApp((s) => s.setNavParam);
  const navParam = useApp((s) => s.navParam);

  const [quiz, setQuiz] = React.useState<QuizData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [current, setCurrent] = React.useState(0);
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [submitted, setSubmitted] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [result, setResult] = React.useState<SubmitResult | null>(null);

  // --- Proctoring ------------------------------------------------------
  // The quiz body is gated behind an explicit consent screen. `cameraAllowed`
  // is null until the student decides; declining is allowed and simply runs
  // the quiz with no camera at all.
  const [cameraAllowed, setCameraAllowed] = React.useState<boolean | null>(null);
  const [attemptId, setAttemptId] = React.useState<string | null>(null);
  const [startingAttempt, setStartingAttempt] = React.useState(false);

  const beginAttempt = React.useCallback(
    async (allow: boolean) => {
      if (!navParam) return;
      setStartingAttempt(true);
      try {
        const r = await fetch(`/api/quizzes/${encodeURIComponent(navParam)}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cameraStatus: allow ? "NOT_REQUESTED" : "DECLINED" }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.attemptId) setAttemptId(d.attemptId);
        // A failed attempt-open must not block the student from taking the
        // quiz; it only means no evidence can be linked.
      } catch {
        /* ignore — quiz still runs */
      } finally {
        setCameraAllowed(allow);
        setStartingAttempt(false);
      }
    },
    [navParam]
  );

  const load = React.useCallback(() => {
    if (!navParam) {
      setError(t("course.001"));
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/quizzes/${encodeURIComponent(navParam)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fail"))))
      .then((d) => {
        setQuiz(d);
        setCurrent(0);
        setAnswers({});
        setSubmitted(false);
        setResult(null);
        setCameraAllowed(null);
        setAttemptId(null);
      })
      .catch(() => {
        setError(t("course.002"));
      })
      .finally(() => setLoading(false));
  }, [navParam]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (loading) return <QuizSkeleton />;
  if (error || !quiz)
    return (
      <Card className="glass">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-base font-semibold mb-1">{error || t("course.003")}</p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => setView("student-course")}
          >
            <ArrowRight className="w-4 h-4 ms-1.5 flip-rtl" />
            {t("course.004")}</Button>
        </CardContent>
      </Card>
    );

  // Result screen
  if (submitted && result) {
    return (
      <ResultScreen
        result={result}
        quiz={quiz}
        onRetry={() => {
          setSubmitted(false);
          setResult(null);
          setCurrent(0);
          setAnswers({});
        }}
        onBackToCourse={() => {
          setView("student-course");
          if (quiz.lesson?.courseSlug) setNavParam(quiz.lesson.courseSlug);
        }}
      />
    );
  }

  const total = quiz.questions.length;
  const q = quiz.questions[current];
  const answered = answers[q.id] !== undefined;
  const answeredCount = Object.keys(answers).length;

  const goNext = () => {
    if (current < total - 1) setCurrent(current + 1);
  };
  const goPrev = () => {
    if (current > 0) setCurrent(current - 1);
  };

  const submit = async () => {
    if (answeredCount < total) {
      const ok = confirm(
        t("course.005", { p1: total - answeredCount })
      );
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/quizzes/${encodeURIComponent(quiz.quiz.id)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answers: Object.entries(answers).map(
              ([questionId, selected]) => ({ questionId, selected })
            ),
          }),
        }
      );
      if (!res.ok) throw new Error("fail");
      const r = (await res.json()) as SubmitResult;
      setResult(r);
      setSubmitted(true);
      toast.success(
        r.passed
          ? t("course.006", { p1: r.percentage })
          : t("course.007", { p1: r.percentage })
      );
    } catch {
      toast.error(t("course.008"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex items-center justify-between gap-3"
      >
        <div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <Button
              variant="ghost"
              size="sm"
              className="px-2 text-muted-foreground"
              onClick={() => {
                setView("student-course");
                if (quiz.lesson?.courseSlug) setNavParam(quiz.lesson.courseSlug);
              }}
            >
              <ArrowRight className="w-3.5 h-3.5 ms-1 flip-rtl" />
              {t("course.009")}</Button>
            <span>›</span>
            <span>Quiz</span>
          </div>
          <h1 className="text-2xl font-bold text-gradient">
            {pickAuto(quiz.quiz.titleAr, quiz.quiz.title)}
          </h1>
          {quiz.quiz.description && (
            <p className="text-sm text-muted-foreground mt-1">
              {quiz.quiz.description}
            </p>
          )}
        </div>
        <Badge
          variant="outline"
          className="bg-primary/5 border-primary/20 text-primary"
        >
          <Trophy className="w-3.5 h-3.5 ms-1" />
          Pass: {quiz.quiz.passMark}%
        </Badge>
      </motion.div>

      {/* Consent gate — nothing is captured, and the questions are not shown,
          until the student has made an explicit choice. */}
      {cameraAllowed === null ? (
        <QuizCameraConsent onDecision={beginAttempt} starting={startingAttempt} />
      ) : (
        <>
      {/* Live camera indicator. Rendered only when the student opted in and an
          attempt row exists to attach the snapshots to. */}
      {cameraAllowed && attemptId && navParam && (
        <div className="flex justify-end">
          <QuizCameraMonitor
            quizId={navParam}
            attemptId={attemptId}
            enabled
          />
        </div>
      )}

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            {t("course.010")}{current + 1} {t("course.011")}{total}
          </span>
          <span className="font-semibold">
            {t("course.012")}{answeredCount}/{total}
          </span>
        </div>
        <Progress value={((current + 1) / total) * 100} />
      </div>

      {/* Question */}
      <AnimatePresence mode="wait">
        <motion.div
          key={q.id}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -30 }}
          transition={{ duration: 0.25 }}
        >
          <Card className="glass">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <Badge
                  variant="outline"
                  className={
                    q.difficulty === "EASY"
                      ? "border-primary/30 text-primary bg-primary/10"
                      : q.difficulty === "MEDIUM"
                      ? "border-amber-400/30 text-amber-600 bg-amber-400/10"
                      : "border-destructive/30 text-destructive bg-destructive/10"
                  }
                >
                  {q.difficulty === "EASY"
                    ? t("course.013")
                    : q.difficulty === "MEDIUM"
                    ? t("course.014")
                    : t("course.015")}
                </Badge>
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  {q.marks} {q.marks === 1 ? t("course.016") : t("course.017")}
                </span>
              </div>
              <CardTitle className="text-lg leading-snug pt-2">
                {pickAuto(q.promptAr, q.prompt)}
              </CardTitle>
              {q.promptAr && q.prompt !== q.promptAr && (
                <CardDescription className="text-xs italic">
                  {q.prompt}
                </CardDescription>
              )}
            </CardHeader>
            <CardContent className="space-y-2.5">
              {q.options.map((opt, idx) => {
                const value = String(idx);
                const selected = answers[q.id] === value;
                return (
                  <motion.button
                    key={value}
                    whileTap={{ scale: 0.98 }}
                    onClick={() =>
                      setAnswers((prev) => ({ ...prev, [q.id]: value }))
                    }
                    className={`w-full flex items-center gap-3 p-3.5 rounded-xl border-2 text-end transition-all ${
                      selected
                        ? "border-primary bg-primary/10 shadow-sm"
                        : "border-border hover:border-primary/40 hover:bg-muted/40"
                    }`}
                  >
                    <span
                      className={`grid place-items-center w-7 h-7 rounded-full shrink-0 text-sm font-bold transition-colors ${
                        selected
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {String.fromCharCode(65 + idx)}
                    </span>
                    <span className="text-sm font-medium flex-1">{opt}</span>
                    {selected && (
                      <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
                    )}
                  </motion.button>
                );
              })}
            </CardContent>
          </Card>
        </motion.div>
      </AnimatePresence>

      {/* Nav */}
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" onClick={goPrev} disabled={current === 0}>
          <ArrowRight className="w-4 h-4 ms-1.5 flip-rtl" />
          {t("course.018")}</Button>

        <div className="flex items-center gap-1.5">
          {quiz.questions.map((qq, i) => {
            const isAnswered = answers[qq.id] !== undefined;
            const isCurrent = i === current;
            return (
              <button
                key={qq.id}
                onClick={() => setCurrent(i)}
                className={`w-2 h-2 rounded-full transition-all ${
                  isCurrent
                    ? "bg-primary w-5"
                    : isAnswered
                    ? "bg-primary/50"
                    : "bg-muted-foreground/30"
                }`}
                aria-label={t("course.019", { p1: i + 1 })}
              />
            );
          })}
        </div>

        {current < total - 1 ? (
          <Button onClick={goNext} disabled={!answered}>
            {t("course.020")}<ArrowLeft className="w-4 h-4 ms-1.5 flip-rtl" />
          </Button>
        ) : (
          <Button
            onClick={submit}
            disabled={submitting}
            className="bg-gradient-to-l from-primary to-amber-500 text-white"
          >
            {submitting ? t("course.021") : t("course.022")}
            {!submitting && <CheckCircle2 className="w-4 h-4 ms-1.5" />}
          </Button>
        )}
      </div>
        </>
      )}
    </div>
  );
}

// ============================================================
// Result Screen
// ============================================================
function ResultScreen({
  result,
  quiz,
  onRetry,
  onBackToCourse,
}: {
  result: SubmitResult;
  quiz: QuizData;
  onRetry: () => void;
  onBackToCourse: () => void;
}) {
  const t = useT();
  const passed = result.passed;
  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, type: "spring" }}
      >
        <Card
          className={`glass overflow-hidden ${
            passed ? "border-primary/30" : "border-amber-400/30"
          }`}
        >
          <div
            className={`h-1.5 ${
              passed
                ? "bg-gradient-to-l from-primary via-teal-500 to-primary"
                : "bg-gradient-to-l from-amber-400 via-amber-500 to-amber-400"
            }`}
          />
          <CardContent className="pt-6 pb-6 text-center">
            <div
              className={`grid place-items-center w-20 h-20 mx-auto rounded-full mb-3 ${
                passed
                  ? "bg-primary/10 text-primary"
                  : "bg-amber-400/15 text-amber-500"
              }`}
            >
              {passed ? (
                <Trophy className="w-10 h-10" />
              ) : (
                <Lightbulb className="w-10 h-10" />
              )}
            </div>
            <div className="text-5xl font-bold text-gradient mb-1">
              {result.percentage}%
            </div>
            <div className="text-sm text-muted-foreground mb-3">
              {result.score} {t("course.011")}{result.totalMarks} {t("course.016")}</div>
            <Badge
              variant="outline"
              className={`text-sm px-3 py-1 ${
                passed
                  ? "border-primary/30 text-primary bg-primary/10"
                  : "border-amber-400/30 text-amber-600 bg-amber-400/10"
              }`}
            >
              {passed
                ? t("course.025")
                : t("course.026", { p1: quiz.quiz.passMark })}
            </Badge>

            <div className="flex flex-col sm:flex-row gap-2 mt-5 justify-center">
              <Button variant="outline" onClick={onBackToCourse}>
                <ArrowRight className="w-4 h-4 ms-1.5 flip-rtl" />
                {t("course.009")}</Button>
              <Button
                onClick={onRetry}
                className="bg-gradient-to-l from-primary to-amber-500 text-white"
              >
                <RotateCw className="w-4 h-4 ms-1.5" />
                {t("course.028")}</Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      <Card className="glass">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ListChecks className="w-5 h-5 text-primary" />
            {t("course.029")}</CardTitle>
          <CardDescription>
            {t("course.030")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {result.answers.map((a, i) => (
            <AnswerRow key={a.questionId} index={i} answer={a} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function AnswerRow({
  index,
  answer,
}: {
  index: number;
  answer: GradedAnswer;
}) {
  const t = useT();
  const selectedIdx = parseInt(answer.selected, 10);
  const correctIdx = parseInt(answer.correctAnswer, 10);
  const selectedLabel = Number.isNaN(selectedIdx)
    ? t("course.031")
    : `${String.fromCharCode(65 + selectedIdx)} — ${answer.options[selectedIdx]}`;
  const correctLabel = Number.isNaN(correctIdx)
    ? "—"
    : `${String.fromCharCode(65 + correctIdx)} — ${answer.options[correctIdx]}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.04 * index }}
      className={`p-3 rounded-xl border ${
        answer.isCorrect
          ? "border-primary/30 bg-primary/5"
          : "border-amber-400/30 bg-amber-400/5"
      }`}
    >
      <div className="flex items-start gap-2.5">
        <div
          className={`grid place-items-center w-7 h-7 rounded-full shrink-0 ${
            answer.isCorrect
              ? "bg-primary text-primary-foreground"
              : "bg-amber-500 text-white"
          }`}
        >
          {answer.isCorrect ? (
            <CheckCircle2 className="w-4 h-4" />
          ) : (
            <XCircle className="w-4 h-4" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold leading-snug mb-1.5">
            {index + 1}. {pickAuto(answer.promptAr, answer.prompt)}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div
              className={`rounded-md p-2 ${
                answer.isCorrect
                  ? "bg-primary/10 text-primary"
                  : "bg-amber-400/10 text-amber-700"
              }`}
            >
              <div className="text-[10px] opacity-70 mb-0.5">{t("course.032")}</div>
              <div className="font-medium">{selectedLabel}</div>
            </div>
            {!answer.isCorrect && (
              <div className="rounded-md p-2 bg-primary/10 text-primary">
                <div className="text-[10px] opacity-70 mb-0.5">
                  {t("course.033")}</div>
                <div className="font-medium">{correctLabel}</div>
              </div>
            )}
          </div>
          {answer.explanation && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground bg-muted/40 p-2 rounded-md">
              <Lightbulb className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
              <span>{answer.explanation}</span>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function QuizSkeleton() {
  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-72 w-full rounded-xl" />
      <div className="flex justify-between">
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
  );
}
