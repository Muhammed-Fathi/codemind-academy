import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Student Leaderboard API
// Returns ranked list of students by XP (computed from stats).
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { buildStats, computeXp, computeLevel, BADGES } from "@/lib/gamification";

/**
 * Hard ceiling on rows scanned/scored per request (see the scoping note below).
 * A single course is far smaller than this; the cap exists so the per-student
 * `buildStats` pass can never be driven to an unbounded cost.
 */
const LEADERBOARD_MAX_ROWS = 200;

export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.136"), 403);

  // Security Audit Gate (pre-P21) — SCOPE + BOUND.
  //
  // The leaderboard used to read EVERY student row in the platform, from every
  // course and both school tracks, and hand the whole roster (names, avatars,
  // XP, level, streak, passes, completions) to any authenticated student. That
  // is a platform-wide directory of minors' identities and academic
  // performance — and it was also an unbounded N+1 (`buildStats` per row) on
  // an unauthenticated-size table, so it doubles as a cheap resource-exhaustion
  // lever.
  //
  // A leaderboard is a CLASS board: it is now scoped to the students enrolled
  // in the caller's own course (the same `Student.group -> Group.courseId`
  // rule that decides content access) and capped, so the surface exposes
  // exactly the peers the student shares a classroom with.
  const me = await db.student.findUnique({
    where: { userId: user.id },
    select: {
      id: true,
      group: { select: { courseId: true, isActive: true } },
    },
  });
  if (!me) return err(tApi("api.136"), 404);

  const courseId = me.group?.isActive ? me.group.courseId : null;
  if (!courseId) return ok({ leaderboard: [], myRank: 0, myStats: null });

  const students = await db.student.findMany({
    where: { group: { isActive: true, courseId } },
    take: LEADERBOARD_MAX_ROWS,
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

  // Find the current user's rank BY STUDENT ID. The previous name matching
  // ("find the entry whose name equals the caller's display name") picked an
  // arbitrary homonym, so a student sharing a name with a higher-ranked peer
  // was handed that peer's rank and stats.
  const myIndex = entries.findIndex((e) => e.studentId === me.id);
  const myRank = myIndex >= 0 ? myIndex + 1 : entries.length;
  const myEntry = entries.find((e) => e.studentId === me.id);

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
