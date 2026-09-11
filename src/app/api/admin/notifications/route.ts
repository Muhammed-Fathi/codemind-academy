import { getServerT } from "@/lib/i18n-server";
// POST /api/admin/notifications — send notification to a user, a group's students, or everyone
// GET /api/admin/notifications — recent notifications (admin view)
//
// PHASE 17 — the broadcast now enforces the SAME preference contract every
// other writer obeys (src/lib/notify.ts): per-type preference flags AND quiet
// hours are honored, reads are bulk (ONE preference findMany, not N), and
// inserts are chunked. WHY: a direct createMany over the whole recipient list
// was a preference bypass — a student who disabled announcements, or who set
// quiet hours, still received the row everywhere else in the platform
// respected. Compatibility: the response still reports `{ ok, sent }`
// (`sent` is now the TRUTHFUL inserted count) plus a `skipped` breakdown, and
// an empty post-preference audience is still the "no recipients" 400.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  ok,
  err,
  requireRole,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import { NotificationType } from "@prisma/client";
import {
  chunkList,
  partitionByNotificationPreferences,
  resolveNotificationChunkSize,
  type NotificationPreferenceRow,
} from "@/lib/notify";
import { validateNotificationLink } from "@/lib/notification-links";

const VALID_TYPES: NotificationType[] = [
  "NEW_LESSON",
  "NEW_QUIZ",
  "QUIZ_RESULT",
  "NEW_HOMEWORK",
  "HOMEWORK_DEADLINE",
  "UPCOMING_SESSION",
  "LOW_ATTENDANCE",
  "MONTHLY_REPORT",
  "SUBSCRIPTION_EXPIRATION",
  "ANNOUNCEMENT",
  "PAYMENT_APPROVED",
  "PAYMENT_REJECTED",
];

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

  const notifications = await db.notification.findMany({
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return ok({ notifications });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  // Phase 20 — a broadcast fans out over the WHOLE recipient set; rate limit
  // before deriving the audience so repeated sends cannot be used as an
  // amplification hammer.
  const rl = await applyRateLimit("notification", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  const message = String(body.message || "").trim();
  const type = (VALID_TYPES.includes(body.type) ? body.type : "ANNOUNCEMENT") as NotificationType;

  if (!title || !message) return err(tApi("api.023"), 400);

  // Phase 17 — links are validated against the deep-link scheme. A missing
  // link stays null; a valid one is canonicalized; a MALFORMED one (external
  // URL, unknown scheme, bad id) is rejected instead of being stored as an
  // inert string payload.
  let link: string | null = null;
  if (body.link !== undefined && body.link !== null && String(body.link).trim() !== "") {
    const validated = validateNotificationLink(body.link);
    if (validated === false) return err("INVALID_NOTIFICATION_LINK", 400);
    link = validated;
  }

  const target = body.target || "all";
  const userIds: string[] = [];

  if (target === "user" && body.userId) {
    userIds.push(String(body.userId));
  } else if (target === "group" && body.groupId) {
    const students = await db.student.findMany({
      where: { groupId: String(body.groupId) },
      select: { userId: true },
    });
    userIds.push(...students.map((s) => s.userId));
  } else if (target === "students") {
    const students = await db.student.findMany({ select: { userId: true } });
    userIds.push(...students.map((s) => s.userId));
  } else if (target === "parents") {
    const parents = await db.parent.findMany({ select: { userId: true } });
    userIds.push(...parents.map((p) => p.userId));
  } else if (target === "teachers") {
    const teachers = await db.teacher.findMany({ select: { userId: true } });
    userIds.push(...teachers.map((t) => t.userId));
  } else {
    const users = await db.user.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    userIds.push(...users.map((u) => u.id));
  }

  if (userIds.length === 0) return err(tApi("api.024"), 400);

  // Phase 17 — the bulk preference contract: ONE read for the whole set,
  // then the exact rules of createNotificationIfAllowed (per-type flag,
  // quiet hours, missing-row-means-defaults-allow), evaluated at one clock.
  const prefRows = (await db.notificationPreference.findMany({
    where: { userId: { in: userIds } },
  })) as unknown as NotificationPreferenceRow[];
  const partition = partitionByNotificationPreferences(userIds, prefRows, type, new Date());

  if (partition.deliver.length === 0) {
    return ok({
      ok: true,
      sent: 0,
      skipped: {
        preferences: partition.skippedPreference,
        quietHours: partition.skippedQuietHours,
      },
    });
  }

  // Chunked, like every other fan-out in the platform — the same bound the
  // session publication uses, so a giant broadcast stays a set of small,
  // bounded statements instead of one oversized one.
  const chunkSize = resolveNotificationChunkSize();
  let sent = 0;
  for (const chunk of chunkList(partition.deliver, chunkSize)) {
    await db.notification.createMany({
      data: chunk.map((uid) => ({
        userId: uid,
        type,
        title,
        message,
        link,
      })),
    });
    sent += chunk.length;
  }

  return ok({
    ok: true,
    sent,
    skipped: {
      preferences: partition.skippedPreference,
      quietHours: partition.skippedQuietHours,
    },
  });
}
