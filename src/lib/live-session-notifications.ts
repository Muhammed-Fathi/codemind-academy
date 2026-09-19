// CodeMind Academy — Phase F live-session & absence notifications.
//
// THE CONTRACT
// ============
// Phase F does NOT add a notification framework. It adds EVENTS to the one the
// platform already has (`Notification` rows + `src/lib/notify.ts` preferences
// + `src/lib/notification-links.ts` deep links), with three Phase F rules:
//
//  1. STRUCTURED SESSION PAYLOAD. A session notification carries
//     `Notification.sessionId`, so the UI renders real actions
//     (Join / Copy link / open the absence case) instead of a text blob. The
//     meeting URL itself is NEVER written into a notification: the client
//     resolves it through `GET /api/live-sessions/[id]/join`, which
//     re-authorizes the reader and re-checks the join window on every call.
//     A notification is therefore undeliverable-as-a-leak by construction.
//
//  2. IDEMPOTENCY IS A DETERMINISTIC KEY, not a hope. Every emitted row
//     carries `dedupeKey` = `<EVENT>:<subjectId>:<material revision>`, and the
//     database enforces `@@unique([userId, dedupeKey])`. A retried request, a
//     double-submitted form or a re-run fan-out computes the same key and
//     inserts nothing; a REAL change (new time, new link, new teacher, new
//     decision) changes the revision and legitimately emits a fresh row.
//
//  3. RECIPIENTS ARE SERVER-RESOLVED. The audience is the LiveSession's own
//     Group (students + their linked parents) or the platform admins — never a
//     client-supplied list.
//
// PREFERENCE POLICY (documented, deliberate)
// ==========================================
//   * Session events (scheduled / link / rescheduled / cancelled) respect the
//     existing `upcomingSession` preference and quiet hours — they are
//     informational, and a student who muted session reminders keeps them
//     muted. The link stays available in the app regardless.
//   * Absence-review events are MANDATORY operational notifications: they are
//     delivered regardless of the `lowAttendance` toggle and quiet hours,
//     because they carry a response deadline and are the only channel through
//     which a student/parent can answer an absence case. This is the
//     platform's existing "critical operational notification" policy.
//   * Admin queue notifications are mandatory for the same reason.

import { db } from "@/lib/db";
import { pickL10n, translate, type Locale } from "@/lib/i18n-core";
import {
  chunkList,
  partitionByNotificationPreferences,
  resolveNotificationChunkSize,
  type NotificationPreferenceRow,
} from "@/lib/notify";
import { mintNotificationLink } from "@/lib/notification-links";
import {
  sessionEventDedupeKey,
  sessionRevision,
  validateMeetingUrl,
  type SessionEventKind,
} from "@/lib/live-session-policy";

type Client = typeof db;

// ---------------------------------------------------------------------------
// The event vocabulary (mirrors NotificationType, spelled once)
// ---------------------------------------------------------------------------

export const LIVE_SESSION_NOTIFICATION_TYPES = {
  SESSION_SCHEDULED: "SESSION_SCHEDULED",
  SESSION_LINK: "SESSION_LINK",
  SESSION_RESCHEDULED: "SESSION_RESCHEDULED",
  SESSION_CANCELLED: "SESSION_CANCELLED",
  ABSENCE_FINALIZED: "ABSENCE_FINALIZED",
  ABSENCE_REASON_SUBMITTED: "ABSENCE_REASON_SUBMITTED",
  ABSENCE_EXCUSED: "ABSENCE_EXCUSED",
  ABSENCE_UNEXCUSED: "ABSENCE_UNEXCUSED",
  ABSENCE_REMINDER: "ABSENCE_REMINDER",
} as const;

export type LiveSessionNotificationType =
  (typeof LIVE_SESSION_NOTIFICATION_TYPES)[keyof typeof LIVE_SESSION_NOTIFICATION_TYPES];

// The localized label authority lives in a PURE module (`notification-labels`)
// because the admin UI also needs it in the browser: importing it from here
// would drag the Prisma client into the client bundle. Re-exported so server
// callers keep using a single import site.
export {
  NOTIFICATION_TYPE_LABEL_KEYS,
  notificationTypeLabelKey,
} from "@/lib/notification-labels";

/** The live-session events that reach students (and parents, when relevant). */
export type SessionNotifyKind = Extract<
  SessionEventKind,
  "SESSION_SCHEDULED" | "SESSION_LINK" | "SESSION_RESCHEDULED" | "SESSION_CANCELLED"
>;

/** Which audience a session event addresses. */
export type SessionNotifyAudience = "STUDENTS" | "STUDENTS_AND_PARENTS";

export type SessionNotificationInput = {
  id: string;
  groupId: string;
  title: string;
  titleAr: string;
  startAt: Date | string;
  duration: number;
  meetingUrl?: string | null;
  status?: unknown;
  teacherId?: string | null;
  substituteTeacherId?: string | null;
};

export type NotifyOutcome = {
  event: string;
  /** Rows actually inserted by THIS call. */
  delivered: number;
  /** Rows already present (the idempotent replay answer). */
  duplicates: number;
  /** Recipients suppressed by their own preferences (non-mandatory events). */
  skippedPreference: number;
  skippedQuietHours: number;
  /** Resolved audience size before any filtering. */
  audience: number;
};

const EMPTY_OUTCOME = (event: string): NotifyOutcome => ({
  event,
  delivered: 0,
  duplicates: 0,
  skippedPreference: 0,
  skippedQuietHours: 0,
  audience: 0,
});

// ---------------------------------------------------------------------------
// Recipient resolution (server-authoritative; never a client list)
// ---------------------------------------------------------------------------

/** The Group's active, ACTIVE-status students — the live audience. */
export async function sessionStudentUserIds(
  groupId: string,
  client: Client = db
): Promise<string[]> {
  const rows = (await (client as any).student.findMany({
    where: {
      groupId,
      user: { isActive: true, status: "ACTIVE" },
    },
    select: { userId: true },
  })) as Array<{ userId: string }>;
  return Array.from(new Set(rows.map((r) => r.userId))).sort();
}

/** The linked parents of a student set (one row per parent, deduped). */
export async function parentUserIdsForStudents(
  studentIds: readonly string[],
  client: Client = db
): Promise<string[]> {
  if (studentIds.length === 0) return [];
  const links = (await (client as any).parentStudentLink.findMany({
    where: { studentId: { in: [...studentIds] } },
    select: { parent: { select: { userId: true } } },
  })) as Array<{ parent: { userId: string } | null }>;
  return Array.from(
    new Set(links.map((l) => l.parent?.userId).filter((v): v is string => Boolean(v)))
  ).sort();
}

export async function adminUserIds(client: Client = db): Promise<string[]> {
  const rows = (await (client as any).user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
  })) as Array<{ id: string }>;
  return Array.from(new Set(rows.map((r) => r.id))).sort();
}

/** The student ids behind a live audience (used for parent resolution). */
async function sessionStudentIds(groupId: string, client: Client): Promise<string[]> {
  const rows = (await (client as any).student.findMany({
    where: { groupId, user: { isActive: true, status: "ACTIVE" } },
    select: { id: true },
  })) as Array<{ id: string }>;
  return rows.map((r) => r.id).sort();
}

// ---------------------------------------------------------------------------
// The ONE insert primitive (idempotent, preference-aware, mandatory-aware)
// ---------------------------------------------------------------------------

export type NotificationInsert = {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string | null;
  sessionId?: string | null;
  dedupeKey?: string | null;
};

export type InsertResult = "INSERTED" | "DUPLICATE" | "PREFERENCE" | "QUIET_HOURS";

/**
 * Insert one notification row, honoring (in this order):
 *   1. the deterministic dedupe key — `(userId, dedupeKey)` may exist once;
 *   2. the recipient's preference / quiet-hours contract, unless `mandatory`.
 *
 * The unique index is the real guarantee: the pre-check exists to classify the
 * outcome (and to avoid pointless writes), while a racing duplicate is caught
 * and reported as DUPLICATE rather than thrown.
 */
export async function insertNotificationOnce(
  row: NotificationInsert,
  options: {
    mandatory?: boolean;
    preferenceRow?: NotificationPreferenceRow | null;
    now?: Date;
    client?: Client;
    chunkSize?: number;
  } = {}
): Promise<InsertResult> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();

  if (row.dedupeKey) {
    const existing = (await (client as any).notification.findFirst({
      where: { userId: row.userId, dedupeKey: row.dedupeKey },
      select: { id: true },
    })) as { id: string } | null;
    if (existing) return "DUPLICATE";
  }

  if (!options.mandatory) {
    const prefRow =
      options.preferenceRow === undefined
        ? ((await (client as any).notificationPreference.findUnique({
            where: { userId: row.userId },
          })) as NotificationPreferenceRow | null)
        : options.preferenceRow;
    if (prefRow) {
      const partition = partitionByNotificationPreferences(
        [row.userId],
        [prefRow],
        row.type,
        now
      );
      if (partition.deliver.length === 0) {
        return partition.skipped[0]?.reason === "QUIET_HOURS" ? "QUIET_HOURS" : "PREFERENCE";
      }
    }
  }

  try {
    await (client as any).notification.create({
      data: {
        userId: row.userId,
        type: row.type,
        title: row.title,
        message: row.message,
        link: row.link ?? null,
        sessionId: row.sessionId ?? null,
        dedupeKey: row.dedupeKey ?? null,
      },
    });
    return "INSERTED";
  } catch (error) {
    // The unique index fired: another writer (or a concurrent retry) won the
    // race. That is exactly the idempotent outcome, not an error.
    if (row.dedupeKey && isDuplicateError(error)) return "DUPLICATE";
    throw error;
  }
}

function isDuplicateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /unique|duplicate|constraint/i.test(message);
}

/** Fan a pre-rendered payload out to a resolved audience. */
async function fanOut(params: {
  event: string;
  audience: string[];
  mandatory: boolean;
  render: (userId: string) => Omit<NotificationInsert, "userId">;
  dedupeKeyFor: (userId: string) => string | null;
  now: Date;
  client: Client;
  chunkSize?: number;
}): Promise<NotifyOutcome> {
  const outcome = EMPTY_OUTCOME(params.event);
  outcome.audience = params.audience.length;
  if (params.audience.length === 0) return outcome;

  const chunkSize = resolveNotificationChunkSize(params.chunkSize);
  const prefRows = params.mandatory
    ? []
    : ((await (params.client as any).notificationPreference.findMany({
        where: { userId: { in: params.audience } },
      })) as NotificationPreferenceRow[]);
  const prefByUser = new Map(prefRows.map((p) => [p.userId, p]));

  for (const chunk of chunkList(params.audience, chunkSize)) {
    for (const userId of chunk) {
      const result = await insertNotificationOnce(
        { userId, ...params.render(userId), dedupeKey: params.dedupeKeyFor(userId) },
        {
          mandatory: params.mandatory,
          preferenceRow: prefByUser.get(userId) ?? (params.mandatory ? null : undefined),
          now: params.now,
          client: params.client,
        }
      );
      if (result === "INSERTED") outcome.delivered += 1;
      else if (result === "DUPLICATE") outcome.duplicates += 1;
      else if (result === "QUIET_HOURS") outcome.skippedQuietHours += 1;
      else outcome.skippedPreference += 1;
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function sessionDisplayName(session: SessionNotificationInput, locale: Locale): string {
  return pickL10n(locale, session.titleAr, session.title) || "-";
}

/** Locale-aware "when" for any start instant (session or absence context). */
function formatWhen(startAt: Date | string, locale: Locale): string {
  const date = startAt instanceof Date ? startAt : new Date(startAt);
  try {
    return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "ar-EG", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatSessionTime(session: SessionNotificationInput, locale: Locale): string {
  const date = session.startAt instanceof Date ? session.startAt : new Date(session.startAt);
  try {
    return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "ar-EG", {
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function sessionTemplate(
  kind: SessionNotifyKind,
  session: SessionNotificationInput,
  locale: Locale
): { title: string; message: string } {
  const name = sessionDisplayName(session, locale);
  const when = formatSessionTime(session, locale);
  switch (kind) {
    case "SESSION_SCHEDULED":
      return {
        title: translate(locale, "live.notif.scheduledTitle", { p1: name }),
        message: translate(locale, "live.notif.scheduledBody", { p1: when }),
      };
    case "SESSION_LINK":
      return {
        title: translate(locale, "live.notif.linkTitle", { p1: name }),
        message: translate(locale, "live.notif.linkBody", { p1: when }),
      };
    case "SESSION_RESCHEDULED":
      return {
        title: translate(locale, "live.notif.rescheduledTitle", { p1: name }),
        message: translate(locale, "live.notif.rescheduledBody", { p1: when }),
      };
    case "SESSION_CANCELLED":
      return {
        title: translate(locale, "live.notif.cancelledTitle", { p1: name }),
        message: translate(locale, "live.notif.cancelledBody", { p1: when }),
      };
  }
}

// ---------------------------------------------------------------------------
// Public emitters
// ---------------------------------------------------------------------------

/**
 * Emit ONE live-session event to its audience.
 *
 * The dedupe key is `<event>:<sessionId>:<revision>` — the revision covers
 * start/duration/link/status/teacher, so:
 *   * the same event twice  → duplicates (idempotent),
 *   * a reschedule          → a new revision → a real new notification.
 */
export async function notifySessionEvent(params: {
  kind: SessionNotifyKind;
  session: SessionNotificationInput;
  audience?: SessionNotifyAudience;
  locale?: Locale;
  now?: Date;
  client?: Client;
  chunkSize?: number;
}): Promise<NotifyOutcome> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const locale: Locale = params.locale === "en" ? "en" : "ar";
  const audience = params.audience ?? "STUDENTS";
  const event = params.kind;

  const studentUserIds = await sessionStudentUserIds(params.session.groupId, client);
  const recipients =
    audience === "STUDENTS_AND_PARENTS"
      ? Array.from(
          new Set([
            ...studentUserIds,
            ...(await parentUserIdsForStudents(
              await sessionStudentIds(params.session.groupId, client),
              client
            )),
          ])
        ).sort()
      : studentUserIds;

  const revision = sessionRevision(params.session);
  const link = mintNotificationLink("live", params.session.id);

  return fanOut({
    event,
    audience: recipients,
    mandatory: false,
    now,
    client,
    chunkSize: params.chunkSize,
    render: () => ({ type: event, ...sessionTemplate(event, params.session, locale), link, sessionId: params.session.id }),
    dedupeKeyFor: () => sessionEventDedupeKey(event, params.session.id, revision),
  });
}

/**
 * When a session's LINK materially changes, students get the structured
 * SESSION_LINK event (Join / Copy actions). Called by the create/update/
 * reschedule ceremonies after the row is committed; idempotent by revision.
 */
export async function notifySessionLink(params: {
  session: SessionNotificationInput;
  now?: Date;
  client?: Client;
  locale?: Locale;
}): Promise<NotifyOutcome> {
  const valid = validateMeetingUrl(params.session.meetingUrl);
  if (!valid.ok) return EMPTY_OUTCOME("SESSION_LINK");
  return notifySessionEvent({ ...params, kind: "SESSION_LINK", audience: "STUDENTS" });
}

export type AbsenceNotificationContext = {
  reviewId: string;
  status: string;
  reason: string | null;
  sessionId: string;
  sessionTitle: string;
  sessionTitleAr: string;
  startAt: Date | string;
  studentId: string;
  studentName: string;
};

/** The notification payload every absence event reuses. */
function absenceTemplate(
  kind: "ABSENCE_FINALIZED" | "ABSENCE_EXCUSED" | "ABSENCE_UNEXCUSED" | "ABSENCE_REASON_SUBMITTED",
  ctx: AbsenceNotificationContext,
  locale: Locale
): { title: string; message: string } {
  const sessionName = pickL10n(locale, ctx.sessionTitleAr, ctx.sessionTitle) || "-";
  const when = formatWhen(ctx.startAt, locale);
  switch (kind) {
    case "ABSENCE_FINALIZED":
      return {
        title: translate(locale, "absence.notif.finalizedTitle", { p1: sessionName }),
        message: translate(locale, "absence.notif.finalizedBody", { p1: when }),
      };
    case "ABSENCE_EXCUSED":
      return {
        title: translate(locale, "absence.notif.excusedTitle", { p1: sessionName }),
        message: translate(locale, "absence.notif.excusedBody", { p1: when }),
      };
    case "ABSENCE_UNEXCUSED":
      return {
        title: translate(locale, "absence.notif.unexcusedTitle", { p1: sessionName }),
        message: translate(locale, "absence.notif.unexcusedBody", { p1: when }),
      };
    case "ABSENCE_REASON_SUBMITTED":
      return {
        title: translate(locale, "absence.notif.reasonTitle", { p1: ctx.studentName }),
        message: translate(locale, "absence.notif.reasonBody", {
          p1: ctx.studentName,
          p2: sessionName,
        }),
      };
  }
}

/**
 * The finalized absence reaches the STUDENT and every LINKED PARENT — the
 * operational pair the roadmap names in decision R. Mandatory (see header).
 */
export async function notifyAbsenceFinalized(params: {
  ctx: AbsenceNotificationContext;
  now?: Date;
  client?: Client;
  locale?: Locale;
}): Promise<NotifyOutcome> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const locale: Locale = params.locale === "en" ? "en" : "ar";

  const student = (await (client as any).student.findUnique({
    where: { id: params.ctx.studentId },
    select: { userId: true },
  })) as { userId: string } | null;
  const parents = await parentUserIdsForStudents([params.ctx.studentId], client);
  const audience = Array.from(new Set([...(student ? [student.userId] : []), ...parents])).sort();

  const link = mintNotificationLink("absence", params.ctx.reviewId);
  return fanOut({
    event: "ABSENCE_FINALIZED",
    audience,
    mandatory: true,
    now,
    client,
    render: () => ({
      type: "ABSENCE_FINALIZED",
      ...absenceTemplate("ABSENCE_FINALIZED", params.ctx, locale),
      link,
      sessionId: params.ctx.sessionId,
    }),
    // One row per case per user: a retry never duplicates, and a decision
    // later emits its OWN event key.
    dedupeKeyFor: () => `ABSENCE_FINALIZED:${params.ctx.reviewId}`,
  });
}

/** A submitted reason notifies the ADMINS (the review queue's inbox). */
export async function notifyAbsenceReasonSubmitted(params: {
  ctx: AbsenceNotificationContext;
  now?: Date;
  client?: Client;
  locale?: Locale;
}): Promise<NotifyOutcome> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const locale: Locale = params.locale === "en" ? "en" : "ar";
  const audience = await adminUserIds(client);
  return fanOut({
    event: "ABSENCE_REASON_SUBMITTED",
    audience,
    mandatory: true,
    now,
    client,
    render: () => ({
      type: "ABSENCE_REASON_SUBMITTED",
      ...absenceTemplate("ABSENCE_REASON_SUBMITTED", params.ctx, locale),
      link: null,
      sessionId: params.ctx.sessionId,
    }),
    // A case may receive several reasons (student then parent): the admins are
    // told once per submission, keyed by submission identity.
    dedupeKeyFor: () =>
      `ABSENCE_REASON_SUBMITTED:${params.ctx.reviewId}:${(params.ctx.reason ?? "").slice(0, 40)}`,
  });
}

/** The decision reaches the student AND the linked parents. Mandatory. */
export async function notifyAbsenceDecision(params: {
  ctx: AbsenceNotificationContext;
  decision: "EXCUSE" | "UNEXCUSE";
  now?: Date;
  client?: Client;
  locale?: Locale;
}): Promise<NotifyOutcome> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const locale: Locale = params.locale === "en" ? "en" : "ar";

  const student = (await (client as any).student.findUnique({
    where: { id: params.ctx.studentId },
    select: { userId: true },
  })) as { userId: string } | null;
  const parents = await parentUserIdsForStudents([params.ctx.studentId], client);
  const audience = Array.from(new Set([...(student ? [student.userId] : []), ...parents])).sort();

  const kind = params.decision === "EXCUSE" ? "ABSENCE_EXCUSED" : "ABSENCE_UNEXCUSED";
  const link = mintNotificationLink("absence", params.ctx.reviewId);
  return fanOut({
    event: kind,
    audience,
    mandatory: true,
    now,
    client,
    render: () => ({
      type: kind,
      ...absenceTemplate(kind, params.ctx, locale),
      link,
      sessionId: params.ctx.sessionId,
    }),
    dedupeKeyFor: () => `${kind}:${params.ctx.reviewId}`,
  });
}
