// CodeMind Academy — Notification Preferences API
// Works for any logged-in user (student/parent/teacher/admin).
//
// Phase 26E — this is the SINGLE implementation behind both
// `/api/students/me/notification-prefs` and its parent counterpart
// `/api/parents/me/notification-prefs` (a re-export), so the parent surface
// inherits every rule here verbatim:
//   * the row key is ALWAYS the authenticated session user (`user.id`) — no
//     request body can name a user, a row id or a role;
//   * only the declared preference keys are written (an unknown key, or a
//     value of the wrong type, is ignored rather than persisted);
//   * quiet hours are `HH:MM` or explicit null, validated by
//     `normalizeQuietHour` (a free-form or oversized string is discarded).
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { normalizeQuietHour } from "@/lib/notify";

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
  // `undefined` means "not written"; `null` is the explicit clear.
  const quietStart = normalizeQuietHour(body.quietHoursStart);
  if (quietStart !== undefined) data.quietHoursStart = quietStart;
  const quietEnd = normalizeQuietHour(body.quietHoursEnd);
  if (quietEnd !== undefined) data.quietHoursEnd = quietEnd;

  const prefs = await db.notificationPreference.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
  });
  return ok({ prefs });
}
