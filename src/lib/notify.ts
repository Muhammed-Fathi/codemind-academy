// CodeMind Academy — Notification helper with preference enforcement
// Checks NotificationPreference before creating notifications.
//
// Phase 17 additions (below the line): the SAME preference contract in bulk
// form — one preference read per recipient SET, not one per recipient — used
// by the session-publication fan-out (`src/lib/session-notifications.ts`) and
// by the admin broadcast route. The single-create helpers above are kept
// byte-for-byte identical in behaviour: they are the contract every other
// writer (payments, referral) already relies on.
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

/**
 * The preference row shape the bulk partition reads. Exported so the session
 * fan-out and the broadcast route can type a `findMany` result without
 * importing the generated Prisma namespace (the two callers use structural
 * client types on purpose).
 */
export type NotificationPreferenceRow = NotificationPrefFields & {
  userId: string;
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

// ---------------------------------------------------------------------------
// Phase 17 — the SAME contract in bulk form
// ---------------------------------------------------------------------------
//
// The bulk paths (session fan-out, admin broadcast) enforce IDENTICAL rules
// to createNotificationIfAllowed —
//
//   1. the per-type flag for the notification's type must be enabled;
//   2. quiet hours suppress the notification entirely (skip, not defer);
//   3. a missing preference row means the schema defaults, i.e. ALLOWED;
//
// — but as PURE functions over an already-loaded preference set, so a fan-out
// over N recipients costs ONE `findMany` total instead of N `findUnique`s.

/** Which preference field gates `type`, if any (unknown types default to allow). */
export function preferenceFieldForType(
  type: string
): keyof NotificationPrefFields | null {
  return TYPE_TO_PREF[type] ?? null;
}

/** Quiet-hours check with an INJECTED clock — same window rule as above. */
export function isInQuietHoursAt(
  quietStart: string | null,
  quietEnd: string | null,
  now: Date
): boolean {
  if (!quietStart || !quietEnd) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const [sH, sM] = quietStart.split(":").map(Number);
  const [eH, eM] = quietEnd.split(":").map(Number);
  if ([sH, sM, eH, eM].some((v) => !Number.isFinite(v))) return false;
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  return nowMin >= startMin || nowMin < endMin;
}

export type PreferenceSkipReason = "PREFERENCE_DISABLED" | "QUIET_HOURS";

export type PreferencePartition<T extends string = string> = {
  /** Users allowed to receive the notification, in input order. */
  deliver: T[];
  /** Users suppressed, each with the exact reason (for audit/reporting). */
  skipped: Array<{ userId: T; reason: PreferenceSkipReason }>;
  skippedPreference: number;
  skippedQuietHours: number;
};

/**
 * Partition a recipient id set by the notification preference contract.
 *
 * Pure: it takes the ONE bulk-loaded preference row set and the run's single
 * `now` (quiet hours are evaluated ONCE per run, so two chunks of the same
 * run can never disagree about whether a user was quiet when the run
 * started). Order of `userIds` is preserved on the deliver side, so the
 * caller controls determinism there.
 */
export function partitionByNotificationPreferences<T extends string>(
  userIds: readonly T[],
  preferenceRows: readonly NotificationPreferenceRow[],
  type: string,
  now: Date
): PreferencePartition<T> {
  const field = preferenceFieldForType(type);
  const byUser = new Map(preferenceRows.map((row) => [row.userId, row]));
  const deliver: T[] = [];
  const skipped: Array<{ userId: T; reason: PreferenceSkipReason }> = [];
  for (const userId of userIds) {
    const prefs = byUser.get(userId);
    if (prefs && field && prefs[field] === false) {
      skipped.push({ userId, reason: "PREFERENCE_DISABLED" });
      continue;
    }
    if (
      prefs &&
      isInQuietHoursAt(prefs.quietHoursStart, prefs.quietHoursEnd, now)
    ) {
      skipped.push({ userId, reason: "QUIET_HOURS" });
      continue;
    }
    deliver.push(userId);
  }
  return {
    deliver,
    skipped,
    skippedPreference: skipped.filter((s) => s.reason === "PREFERENCE_DISABLED").length,
    skippedQuietHours: skipped.filter((s) => s.reason === "QUIET_HOURS").length,
  };
}

/** Deterministic, bounded slicing — the shared chunker for every fan-out. */
export function chunkList<T>(items: readonly T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * The platform default fan-out chunk size.
 *
 * 500 is well inside the binding budget of BOTH supported Prisma backends:
 * a Notification createMany binds 5 variables per row (userId, type, title,
 * message, link; id/isRead/createdAt carry defaults), so a chunk binds 2,500
 * variables — far below SQLite's 32,766-variable ceiling (13× headroom) and
 * Postgres's 32,767-parameter limit (13× headroom). Chunks are also small
 * enough for SQLite `createMany` to stay a single, short statement.
 */
export const NOTIFICATION_FANOUT_DEFAULT_CHUNK_SIZE = 500;
export const NOTIFICATION_FANOUT_MAX_CHUNK_SIZE = 1000;

/**
 * Resolve the effective chunk size: env override
 * (`NOTIFICATION_FANOUT_CHUNK_SIZE`) when it parses to a sane integer,
 * otherwise the platform default. Clamped to [1, MAX] so a hostile or sloppy
 * value degrades to a safe bound rather than exploding statement size.
 */
export function resolveNotificationChunkSize(
  raw?: unknown
): number {
  const source = raw ?? process.env.NOTIFICATION_FANOUT_CHUNK_SIZE;
  if (source !== undefined && source !== null && String(source).trim() !== "") {
    const parsed = Number.parseInt(String(source), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(parsed, NOTIFICATION_FANOUT_MAX_CHUNK_SIZE);
    }
  }
  return NOTIFICATION_FANOUT_DEFAULT_CHUNK_SIZE;
}
