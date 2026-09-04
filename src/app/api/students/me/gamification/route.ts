import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Gamification API
// Returns XP, level, streak, badges for the current student.
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import {
  buildStats,
  computeXp,
  computeLevel,
  awardBadges,
  BADGES,
} from "@/lib/gamification";

export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.134"), 403);

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.135"), 404);

  const stats = await buildStats(student.id);
  const xp = computeXp(stats);
  const level = computeLevel(xp);
  // Auto-award any newly-earned badges
  const newlyEarned = await awardBadges(student.id, stats);
  const earnedRows = await db.studentBadge.findMany({
    where: { studentId: student.id },
    orderBy: { earnedAt: "desc" },
  });
  const earnedCodes = new Set(earnedRows.map((r) => r.code));
  const badges = BADGES.map((b) => ({
    ...b,
    earned: earnedCodes.has(b.code),
    earnedAt: earnedRows.find((r) => r.code === b.code)?.earnedAt || null,
  }));

  return ok({
    xp,
    level,
    stats,
    badges,
    newlyEarned: newlyEarned.map((b) => b.code),
  });
}
