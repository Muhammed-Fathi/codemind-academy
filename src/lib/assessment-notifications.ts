// CodeMind Academy — Phase G: publish notifications for Quiz / Homework.
//
// REUSES the existing notification machinery — no second engine:
//   * recipients: `getEligibleSessionRecipients` (the SAME course × track
//     derivation the NEW_LESSON fan-out uses — active group, ACTIVE account,
//     track fit);
//   * preferences + quiet hours: `partitionByNotificationPreferences`
//     (one bulk read, run-single clock);
//   * idempotency: `Notification.dedupeKey` with UNIQUE(userId, dedupeKey) —
//     a double publish (or a re-open after close) can never fan out twice.
//
// Types reused: NEW_HOMEWORK / NEW_QUIZ (both pre-existing NotificationType
// values with existing preference flags — no enum change, no migration).

import { db } from "@/lib/db";
import {
  getEligibleSessionRecipients,
} from "@/lib/session-notifications";
import {
  chunkList,
  partitionByNotificationPreferences,
  NOTIFICATION_FANOUT_DEFAULT_CHUNK_SIZE,
  type NotificationPreferenceRow,
} from "@/lib/notify";
import { mintNotificationLink } from "@/lib/notification-links";
import type { TrackScope } from "@/lib/track-scope";
import type { NotificationType } from "@prisma/client";

export type AssessmentPublishNotification = {
  kind: "HOMEWORK" | "QUIZ";
  /** Homework or Quiz id. */
  id: string;
  /** Localized title for the notification body. */
  title: string;
  /** Localized message. */
  message: string;
  courseId: string;
  trackScope: TrackScope | string;
};

/**
 * Fan out a publish notification to eligible students. Best-effort by design:
 * a notification failure must never fail a publish (the lifecycle transition
 * is already committed + audited by the caller). Returns delivery stats for
 * the route to surface; never throws.
 */
export async function notifyAssessmentPublished(
  input: AssessmentPublishNotification
): Promise<{ eligible: number; delivered: number; skipped: number }> {
  const none = { eligible: 0, delivered: 0, skipped: 0 };
  try {
    const type: NotificationType =
      input.kind === "HOMEWORK" ? "NEW_HOMEWORK" : "NEW_QUIZ";
    const dedupeKey = `${input.kind === "HOMEWORK" ? "homework" : "quiz"}-publish:${input.id}`;
    const link =
      mintNotificationLink(input.kind === "HOMEWORK" ? "homework" : "quiz", input.id) ?? null;

    const recipients = await getEligibleSessionRecipients({
      courseId: input.courseId,
      trackScope: input.trackScope,
    });
    if (recipients.length === 0) return none;

    const userIds = recipients.map((r) => r.userId);
    const prefRows = (await db.notificationPreference.findMany({
      where: { userId: { in: userIds } },
    })) as unknown as NotificationPreferenceRow[];
    const partition = partitionByNotificationPreferences(
      userIds,
      prefRows,
      type,
      new Date()
    );

    let delivered = 0;
    for (const chunk of chunkList(partition.deliver, NOTIFICATION_FANOUT_DEFAULT_CHUNK_SIZE)) {
      // dedupeKey + UNIQUE(userId, dedupeKey) is the idempotency state: the
      // first publish claims a row per user; replays skip them individually.
      const existing = await db.notification.findMany({
        where: { dedupeKey, userId: { in: chunk } },
        select: { userId: true },
      });
      const have = new Set(existing.map((r) => r.userId));
      const fresh = chunk.filter((userId) => !have.has(userId));
      if (fresh.length === 0) continue;
      // createMany cannot carry per-row conflict handling through Prisma on
      // BOTH providers, so rows are inserted one-by-one with a duplicate-key
      // swallow: bounded chunk sizes keep this cheap, correctness beats bulk.
      for (const userId of fresh) {
        try {
          await db.notification.create({
            data: {
              userId,
              type,
              title: input.title,
              message: input.message,
              link,
              dedupeKey,
            },
          });
          delivered += 1;
        } catch {
          // A concurrent twin (double publish race) inserted first — the
          // UNIQUE(userId, dedupeKey) constraint is the authority.
        }
      }
    }

    return {
      eligible: recipients.length,
      delivered,
      skipped: partition.skippedPreference + partition.skippedQuietHours,
    };
  } catch {
    return none;
  }
}
