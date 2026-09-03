// CodeMind Academy — Notification Preferences API
// Works for any logged-in user (student/parent/teacher/admin).
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

const PREF_FIELDS = [
  "newLesson",
  "newQuiz",
  "quizResult",
  "newHomework",
  "homeworkDeadline",
  "upcomingSession",
  "lowAttendance",
  "monthlyReport",
  "subscriptionExpiration",
  "announcements",
  "emailEnabled",
  "pushEnabled",
] as const;

// GET — returns current preferences (creates default if not exists)
export async function GET() {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  let prefs = await db.notificationPreference.findUnique({
    where: { userId: user.id },
  });
  if (!prefs) {
    prefs = await db.notificationPreference.create({
      data: { userId: user.id },
    });
  }
  return ok({ prefs });
}

// PUT — update preferences
export async function PUT(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const data: any = {};
  for (const field of PREF_FIELDS) {
    if (typeof body[field] === "boolean") {
      data[field] = body[field];
    }
  }
  if (typeof body.quietHoursStart === "string" || body.quietHoursStart === null) {
    data.quietHoursStart = body.quietHoursStart;
  }
  if (typeof body.quietHoursEnd === "string" || body.quietHoursEnd === null) {
    data.quietHoursEnd = body.quietHoursEnd;
  }

  const prefs = await db.notificationPreference.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
  });
  return ok({ prefs });
}
