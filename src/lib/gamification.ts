// CodeMind Academy — Gamification engine
// XP rules, badge definitions, and helpers.
// XP is computed dynamically from lesson progress + quiz attempts +
// homework submissions + attendance. Streaks are day-over-day active days.

import { db } from "@/lib/db";

export type BadgeDef = {
  code: string;
  title: string;
  titleAr: string;
  description: string;
  icon: string; // emoji or lucide name
  color: string; // tailwind gradient classes
  check: (stats: GamificationStats) => boolean;
};

export type GamificationStats = {
  lessonsCompleted: number;
  quizzesTaken: number;
  quizzesPassed: number;
  avgQuizPct: number;
  homeworkSubmitted: number;
  homeworkGraded: number;
  attendancePct: number;
  currentStreak: number;
  longestStreak: number;
};

export const XP_RULES = {
  LESSON_COMPLETED: 50,
  QUIZ_PASSED: 30,
  QUIZ_PERFECT: 50, // bonus on top of passed
  HOMEWORK_SUBMITTED: 20,
  HOMEWORK_GRADED_HIGH: 25, // grade >= 8/10
  ATTENDANCE_PRESENT: 10,
  // Daily login bonus
  DAILY_LOGIN: 5,
};

export const LEVELS = [
  { level: 1, title: "مبتدئ", titleEn: "Beginner", minXp: 0, color: "from-slate-400 to-slate-500" },
  { level: 2, title: "طالب", titleEn: "Learner", minXp: 100, color: "from-emerald-400 to-teal-500" },
  { level: 3, title: "متمكن", titleEn: "Practitioner", minXp: 300, color: "from-teal-400 to-cyan-500" },
  { level: 4, title: "محترف", titleEn: "Skilled", minXp: 600, color: "from-amber-400 to-orange-500" },
  { level: 5, title: "خبير", titleEn: "Expert", minXp: 1000, color: "from-orange-400 to-rose-500" },
  { level: 6, title: "أسطورة", titleEn: "Legend", minXp: 1500, color: "from-rose-400 to-purple-500" },
];

export const BADGES: BadgeDef[] = [
  {
    code: "first-lesson",
    title: "First Step",
    titleAr: "أول خطوة",
    description: "خلصت أول Lesson ليك في الكورس.",
    icon: "🎯",
    color: "from-emerald-400 to-teal-500",
    check: (s) => s.lessonsCompleted >= 1,
  },
  {
    code: "lesson-explorer",
    title: "Lesson Explorer",
    titleAr: "مستكشف الدروس",
    description: "خلصت 5 Lessons.",
    icon: "🧭",
    color: "from-teal-400 to-cyan-500",
    check: (s) => s.lessonsCompleted >= 5,
  },
  {
    code: "quiz-rookie",
    title: "Quiz Rookie",
    titleAr: "باديء Quizzes",
    description: "حليت أول Quiz ليك.",
    icon: "✏️",
    color: "from-amber-400 to-orange-400",
    check: (s) => s.quizzesTaken >= 1,
  },
  {
    code: "quiz-master",
    title: "Quiz Master",
    titleAr: "بطل Quizzes",
    description: "نجحت في 5 Quizzes.",
    icon: "🏆",
    color: "from-amber-500 to-orange-500",
    check: (s) => s.quizzesPassed >= 5,
  },
  {
    code: "perfect-score",
    title: "Perfect Score",
    titleAr: "الدرجة الكاملة",
    description: "جبت 100% في Quiz.",
    icon: "💯",
    color: "from-rose-400 to-pink-500",
    check: (s) => s.avgQuizPct >= 100 && s.quizzesTaken > 0,
  },
  {
    code: "homework-hero",
    title: "Homework Hero",
    titleAr: "بطل الواجبات",
    description: "سلّمت 3 واجبات.",
    icon: "📚",
    color: "from-indigo-400 to-purple-500",
    check: (s) => s.homeworkSubmitted >= 3,
  },
  {
    code: "attendance-streak",
    title: "Show Up",
    titleAr: "حاضر ومستني",
    description: "حضرت 5 Sessions.",
    icon: "📅",
    color: "from-cyan-400 to-blue-500",
    check: (s) => s.attendancePct >= 80,
  },
  {
    code: "week-streak",
    title: "Week Warrior",
    titleAr: "بطل الأسبوع",
    description: "اتابع 7 أيام ورا بعض.",
    icon: "🔥",
    color: "from-orange-500 to-red-500",
    check: (s) => s.currentStreak >= 7,
  },
  {
    code: "month-streak",
    title: "Monthly Master",
    titleAr: "بطل الشهر",
    description: "اتابع 30 يوم ورا بعض.",
    icon: "⚡",
    color: "from-purple-500 to-pink-500",
    check: (s) => s.currentStreak >= 30,
  },
];

export function computeLevel(xp: number) {
  let result = LEVELS[0];
  for (const l of LEVELS) {
    if (xp >= l.minXp) result = l;
  }
  const nextIndex = LEVELS.findIndex((l) => l.level === result.level) + 1;
  const next = LEVELS[nextIndex];
  const progress = next
    ? ((xp - result.minXp) / (next.minXp - result.minXp)) * 100
    : 100;
  return {
    current: result,
    next,
    progress: Math.min(100, Math.max(0, progress)),
    xpToNext: next ? next.minXp - xp : 0,
  };
}

// Compute XP from raw student stats
export function computeXp(stats: GamificationStats): number {
  let xp = 0;
  xp += stats.lessonsCompleted * XP_RULES.LESSON_COMPLETED;
  xp += stats.quizzesPassed * XP_RULES.QUIZ_PASSED;
  if (stats.avgQuizPct === 100 && stats.quizzesTaken > 0)
    xp += XP_RULES.QUIZ_PERFECT;
  xp += stats.homeworkSubmitted * XP_RULES.HOMEWORK_SUBMITTED;
  xp += stats.homeworkGraded * XP_RULES.HOMEWORK_GRADED_HIGH;
  // attendance bonus
  if (stats.attendancePct >= 80) xp += 50;
  // streak bonus
  xp += Math.min(stats.currentStreak * 5, 150);
  return xp;
}

// Build stats from DB
export async function buildStats(studentId: string): Promise<GamificationStats> {
  const [lessons, quizAttempts, homeworkSubs, attendances] = await Promise.all([
    db.lessonProgress.findMany({
      where: { studentId, isCompleted: true },
      select: { id: true, lastViewedAt: true },
    }),
    db.quizAttempt.findMany({
      where: { studentId },
      select: { id: true, percentage: true, passed: true, finishedAt: true },
    }),
    db.homeworkSubmission.findMany({
      where: { studentId },
      select: { id: true, status: true, grade: true, submittedAt: true },
    }),
    db.attendance.findMany({
      where: { studentId },
      select: { id: true, status: true, createdAt: true },
    }),
  ]);

  const lessonsCompleted = lessons.length;
  const quizzesTaken = quizAttempts.length;
  const quizzesPassed = quizAttempts.filter((a) => a.passed).length;
  const avgQuizPct =
    quizzesTaken > 0
      ? Math.round(
          quizAttempts.reduce((s, a) => s + a.percentage, 0) / quizzesTaken
        )
      : 0;
  const homeworkSubmitted = homeworkSubs.filter(
    (h) => h.status === "SUBMITTED" || h.status === "GRADED" || h.status === "LATE"
  ).length;
  const homeworkGraded = homeworkSubs.filter(
    (h) => h.status === "GRADED" && (h.grade ?? 0) >= 8
  ).length;
  const attendanceTotal = attendances.length;
  const attendancePresent = attendances.filter(
    (a) => a.status === "PRESENT"
  ).length;
  const attendancePct =
    attendanceTotal > 0
      ? Math.round((attendancePresent / attendanceTotal) * 100)
      : 0;

  // Streak: count consecutive days with at least one activity (last 60 days)
  const activityDates = new Set<string>();
  const collect = (arr: { lastViewedAt?: Date | null; finishedAt?: Date | null; submittedAt?: Date | null; createdAt?: Date | null }) => {
    const d = arr.lastViewedAt || arr.finishedAt || arr.submittedAt || arr.createdAt;
    if (d) activityDates.add(d.toISOString().slice(0, 10));
  };
  lessons.forEach(collect);
  quizAttempts.forEach(collect);
  homeworkSubs.forEach(collect);
  attendances.forEach(collect);

  let currentStreak = 0;
  let longestStreak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // walk backwards from today
  for (let i = 0; i < 60; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (activityDates.has(key)) {
      if (i === 0 || currentStreak > 0) currentStreak++;
      else currentStreak = 1;
    } else if (i > 0) {
      // gap — stop current streak counting
      if (currentStreak > 0) break;
    }
  }
  // simple longest run
  let run = 0;
  for (let i = 0; i < 60; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (activityDates.has(key)) {
      run++;
      longestStreak = Math.max(longestStreak, run);
    } else {
      run = 0;
    }
  }

  return {
    lessonsCompleted,
    quizzesTaken,
    quizzesPassed,
    avgQuizPct,
    homeworkSubmitted,
    homeworkGraded,
    attendancePct,
    currentStreak,
    longestStreak,
  };
}

// Award badges based on stats. Returns newly earned badge codes.
export async function awardBadges(
  studentId: string,
  stats: GamificationStats
): Promise<BadgeDef[]> {
  const earned: BadgeDef[] = [];
  for (const b of BADGES) {
    if (b.check(stats)) {
      try {
        await db.studentBadge.upsert({
          where: { studentId_code: { studentId, code: b.code } },
          update: {},
          create: { studentId, code: b.code },
        });
        earned.push(b);
      } catch {
        // ignore
      }
    }
  }
  return earned;
}
