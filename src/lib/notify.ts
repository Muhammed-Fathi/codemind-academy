// CodeMind Academy — Notification helper with preference enforcement
// Checks NotificationPreference before creating notifications.
import { db } from "@/lib/db";
import type { NotificationType } from "@prisma/client";

// Map notification type to preference field
const TYPE_TO_PREF: Record<string, keyof NotificationPrefFields> = {
  NEW_LESSON: "newLesson",
  NEW_QUIZ: "newQuiz",
  QUIZ_RESULT: "quizResult",
  NEW_HOMEWORK: "newHomework",
  HOMEWORK_DEADLINE: "homeworkDeadline",
  UPCOMING_SESSION: "upcomingSession",
  LOW_ATTENDANCE: "lowAttendance",
  MONTHLY_REPORT: "monthlyReport",
  SUBSCRIPTION_EXPIRATION: "subscriptionExpiration",
  ANNOUNCEMENT: "announcements",
  PAYMENT_APPROVED: "announcements", // use announcements pref
  PAYMENT_REJECTED: "announcements", // use announcements pref
};

type NotificationPrefFields = {
  newLesson: boolean;
  newQuiz: boolean;
  quizResult: boolean;
  newHomework: boolean;
  homeworkDeadline: boolean;
  upcomingSession: boolean;
  lowAttendance: boolean;
  monthlyReport: boolean;
  subscriptionExpiration: boolean;
  announcements: boolean;
  emailEnabled: boolean;
  pushEnabled: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
};

// Check if a notification type is enabled for a user
export async function isNotificationEnabled(
  userId: string,
  type: NotificationType
): Promise<boolean> {
  const prefField = TYPE_TO_PREF[type];
  if (!prefField) return true; // default: allow if no mapping

  const prefs = await db.notificationPreference.findUnique({
    where: { userId },
  });
  if (!prefs) return true; // default: allow if no prefs (defaults are all true)

  return (prefs as any)[prefField] as boolean;
}

// Check if we're in quiet hours for a user
export function isInQuietHours(
  quietStart: string | null,
  quietEnd: string | null
): boolean {
  if (!quietStart || !quietEnd) return false;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const [sH, sM] = quietStart.split(":").map(Number);
  const [eH, eM] = quietEnd.split(":").map(Number);
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;

  if (startMin < endMin) {
    // Same day: 22:00 - 23:00
    return nowMin >= startMin && nowMin < endMin;
  } else {
    // Crosses midnight: 22:00 - 07:00
    return nowMin >= startMin || nowMin < endMin;
  }
}

// Create a notification if the user's preferences allow it.
// Returns true if created, false if skipped.
export async function createNotificationIfAllowed(params: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string | null;
}): Promise<boolean> {
  const { userId, type, title, message, link } = params;

  // Check type preference
  const allowed = await isNotificationEnabled(userId, type);
  if (!allowed) return false;

  // Check quiet hours
  const prefs = await db.notificationPreference.findUnique({
    where: { userId },
  });
  if (prefs && isInQuietHours(prefs.quietHoursStart, prefs.quietHoursEnd)) {
    // In quiet hours — skip push notification, but still create it (marked as read)
    // Actually let's just skip creation entirely during quiet hours
    return false;
  }

  await db.notification.create({
    data: {
      userId,
      type,
      title,
      message,
      link: link || null,
    },
  });
  return true;
}

// Batch create notifications for multiple users (respecting each user's prefs)
export async function createNotificationsIfAllowed(
  notifications: Array<{
    userId: string;
    type: NotificationType;
    title: string;
    message: string;
    link?: string | null;
  }>
): Promise<number> {
  let created = 0;
  for (const n of notifications) {
    const ok = await createNotificationIfAllowed(n);
    if (ok) created++;
  }
  return created;
}
