// CodeMind Academy — Student Leaderboard API
// Returns ranked list of students by XP (computed from stats).
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { buildStats, computeXp, computeLevel, BADGES } from "@/lib/gamification";

export async function GET() {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("الـLeaderboard متاح للطلاب فقط", 403);

  // Get all students with their user info
  const students = await db.student.findMany({
    include: {
      user: { select: { name: true, email: true, avatarUrl: true } },
      badges: { select: { code: true } },
    },
  });

  // Compute XP + level for each student
  const entries: any[] = [];
  for (const s of students) {
    const stats = await buildStats(s.id);
    const xp = computeXp(stats);
    const level = computeLevel(xp);
    const badgeCount = s.badges.length;
    entries.push({
      studentId: s.id,
      name: s.user.name,
      avatarUrl: s.user.avatarUrl,
      xp,
      level: level.current.level,
      levelTitle: level.current.title,
      levelColor: level.current.color,
      badgeCount,
      totalBadges: BADGES.length,
      streak: stats.currentStreak,
      quizzesPassed: stats.quizzesPassed,
      lessonsCompleted: stats.lessonsCompleted,
    });
  }

  // Sort by XP descending
  entries.sort((a, b) => b.xp - a.xp);

  // Find current user's rank
  const myIndex = entries.findIndex((e) => e.studentId === entries.find(e2 => e2.name === user.name)?.studentId);
  const myRank = myIndex >= 0 ? myIndex + 1 : entries.length;
  const myEntry = entries.find((e) => e.name === user.name);

  // Assign ranks
  entries.forEach((e, i) => {
    e.rank = i + 1;
  });

  return ok({
    leaderboard: entries,
    myRank,
    myStats: myEntry
      ? {
          rank: myRank,
          xp: myEntry.xp,
          level: myEntry.level,
          levelTitle: myEntry.levelTitle,
          badgeCount: myEntry.badgeCount,
          streak: myEntry.streak,
        }
      : null,
  });
}
