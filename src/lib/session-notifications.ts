// CodeMind Academy — Session publication notifications (Phase 17).
//
// THE CONTRACT
// ============
// Publishing a session (Phase 13 OPEN) produces exactly one notification
// event: a targeted, preference-aware, deep-linked NEW_LESSON notification
// delivered to the students who are eligible AT THE MOMENT OF PUBLISHING:
//
//   OPEN SESSION (Phase 13 ceremony persists the publication)
//     → derive eligible recipients     (this module, server-side)
//     → respect preferences            (bulk partition, ONE preference read)
//     → chunked fan-out                (bounded createMany, 500 default)
//     → persist per-user notifications (idempotent via (type, link) dedupe)
//     → deep link to the session       (`lesson:<lessonId>`, validated)
//
//   eligible = ACTIVE student (User.isActive AND User.status = ACTIVE)
//     AND enrolled in the lesson's course (active Group, courseId equal)
//     AND the lesson's trackScope applies to the student's own schoolType
//     (SHARED → everyone, ARABIC/LANGUAGE → that track only — the Phase 12
//     helper `canAccessTrackScope`, never a re-implementation)
//
// THE RULES THIS MODULE OWNS
// ==========================
//  1. GROUP IS NOT TRACK. Eligibility is (course × trackScope × active) and
//     is COMPUTED AT PUBLISH TIME from the live Student rows — no segment
//     snapshot, no batch shortcut, never a group-name match. A group mixes
//     ARABIC and LANGUAGE students, so "the group" is never the audience.
//  2. ONE RECIPIENT QUERY. `getEligibleSessionRecipients` is the ONLY way to
//     learn the audience — the fan-out, the admin recipient-count preview
//     and the tests all call it, so a count can never disagree with a
//     delivery (`count = 70, delivered = 93` is impossible by construction).
//  3. PREFERENCES ARE THE SHARED CONTRACT. The per-type flag and quiet-hours
//     rules of `createNotificationIfAllowed` are enforced here through the
//     bulk partition in `src/lib/notify.ts` — same rules, one bulk read.
//     A quiet-hours skip means "not delivered by THIS run" (no row), exactly
//     like the single-create path; a later manual retry re-evaluates.
//  4. IDEMPOTENCY IS PUBLICATION IDENTITY + PER-USER DELIVERY STATE, not a
//     parallel system. The Phase 13 `SessionPublication` row is the anchor:
//     fan-out only ever runs against a lesson that is currently PUBLISHED
//     with a live anchor (an UNPUBLISH deletes the anchor, so a late retry
//     of a withdrawn publication delivers ZERO rows). Within that, one
//     notification per user per publication is enforced by a bounded
//     (type, link) dedupe check ahead of every chunk insert — the same rows
//     the users already hold ARE the delivery state.
//  5. CHUNKS ARE DETERMINISTIC AND RESUMABLE. Recipients are sorted by
//     userId before chunking, chunks run SEQUENTIALLY, and a chunk failure
//     stops the run (chunk N+1 never starts). Retrying re-runs the whole
//     pipeline: completed chunks cost one dedupe query and insert nothing.
//  6. THE LINK IS VALIDATED AND NEVER AUTHORIZATION. The minted
//     `lesson:<id>` link is produced by `src/lib/notification-links.ts`
//     (strict scheme, no external URLs); opening it re-authorizes on the
//     destination routes (Phase 16 contract), so a stale/ineligible link
//     fails safe.
//  7. CONCURRENT OPENS SERIALIZE. The in-process per-lesson mutex below
//     turns the dedupe-check → insert window into a critical section for the
//     ONLY writer that can race itself (two OPEN ceremonies of the same
//     lesson; the lifecycle transaction already serializes the flip itself).
//     The documented deployment is ONE standalone Node server, so a process
//     lock is the whole guarantee; multi-instance deployments would need a
//     database advisory lock — noted in docs/PHASE_17_SESSION_NOTIFICATIONS.md.
//
// See docs/PHASE_17_SESSION_NOTIFICATIONS.md for the full contract.

import { db } from "@/lib/db";
import { pickL10n, translate, type Locale } from "@/lib/i18n-core";
import {
  chunkList,
  partitionByNotificationPreferences,
  resolveNotificationChunkSize,
  type NotificationPreferenceRow,
} from "@/lib/notify";
import { sessionPublicationLink } from "@/lib/notification-links";
import {
  LESSON_CHAIN_SELECT,
  resolveLessonCourseId,
  type LessonChain,
} from "@/lib/session-progress";
import { canAccessTrackScope, normalizeTrackScope, type TrackScope } from "@/lib/track-scope";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The ONE notification type a session publication emits (no parallel types). */
export const SESSION_PUBLICATION_NOTIFICATION_TYPE = "NEW_LESSON" as const;

/** Machine-readable outcome codes — the API's stable contract. */
export type SessionNotificationCode =
  /** the pipeline ran and inserted at least one row */
  | "EMITTED"
  /** the pipeline ran, inserted nothing new — every deliverable user already
   * held the publication's row (the idempotent replay answer) */
  | "ALREADY_DELIVERED"
  /** the pipeline ran and had NOTHING to attempt: every eligible student was
   * suppressed by their own notification preferences or quiet hours (honest
   * zero-delivery; NOT reported as "already notified") */
  | "SUPPRESSED_BY_PREFERENCES"
  /** eligibility derived zero recipients (nobody to notify — not an error) */
  | "NO_RECIPIENTS"
  /** a chunk failed: prior chunks are delivered, the rest was never attempted;
   *  retrying resumes through the dedupe with no duplicates */
  | "EMITTED_PARTIAL"
  /** the lesson does not exist */
  | "LESSON_NOT_FOUND"
  /** the lesson is not currently PUBLISHED (DRAFT/READY/refuses silently) */
  | "LESSON_NOT_PUBLISHED"
  /** PUBLISHED but no live SessionPublication anchor (a late retry after an
   *  UNPUBLISH lands here — it MUST deliver zero rows) */
  | "PUBLICATION_MISSING"
  /** the lesson resolves to no course (the same verdict the ceremony gives) */
  | "LESSON_NOT_IN_COURSE";

export type SessionNotificationOutcome = {
  ok: boolean;
  code: SessionNotificationCode;
  lessonId: string;
  publicationId: string | null;
  /** Resolved targeting context (null when the lesson itself failed to load). */
  courseId: string | null;
  trackScope: TrackScope | null;
  /** eligible recipients at run time (the SAME set the admin count shows) */
  eligible: number;
  /** rows inserted by THIS run */
  delivered: number;
  /** deliverable users skipped because they already held the row */
  alreadyNotified: number;
  /** suppressed by the per-type preference flag */
  skippedPreference: number;
  /** suppressed by quiet hours (evaluated once, at the run's `now`) */
  skippedQuietHours: number;
  chunksPlanned: number;
  chunksDone: number;
  /** 0-based chunk indexes that failed (non-empty only for EMITTED_PARTIAL) */
  failedChunks: number[];
  /** the minted deep link (validated scheme) */
  link: string | null;
  message: string;
};

export type SessionRecipient = {
  studentId: string;
  userId: string;
  /** normalized; null = unspecified (SHARED-eligible only, per Phase 12) */
  schoolType: "ARABIC" | "LANGUAGE" | null;
};

// ---------------------------------------------------------------------------
// Eligibility — the ONE derivation, shared by count / fan-out / tests
// ---------------------------------------------------------------------------

/**
 * The Prisma `where` fragment over Student for the publication audience.
 * Course membership goes through the active Group (the SAME enrollment
 * definition `getEnrollment` uses) and the active-account gate mirrors the
 * platform auth rule — an inactive user or a suspended/signed-off account
 * (`status != ACTIVE`) is never a recipient, even mid-session.
 */
export function sessionRecipientsWhere(params: {
  courseId: string;
  trackScope: TrackScope | string;
}) {
  const scope = normalizeTrackScope(params.trackScope) ?? "SHARED";
  return {
    group: { isActive: true, courseId: params.courseId },
    user: { isActive: true, status: "ACTIVE" as const },
    // SHARED applies to every student (including unspecified school type,
    // which Phase 12 defines as SHARED-eligible only). Track-specific lessons
    // are an exact-match on the student's own row — never a request value.
    ...(scope === "SHARED" ? {} : { schoolType: scope }),
  } as const;
}

/**
 * The runtime mirror of `sessionRecipientsWhere` over already-loaded fields —
 * the pure predicate the tests exhaust. It reuses Phase 12's
 * `canAccessTrackScope`, so the SQL side and the predicate side encode ONE
 * rule (an ARABIC student + a LANGUAGE lesson is false on BOTH).
 */
export function isEligibleSessionRecipient(
  student: {
    schoolType?: unknown;
    groupIsActive?: unknown;
    groupCourseId?: string | null;
    userIsActive?: unknown;
    userStatus?: unknown;
  },
  publication: { courseId: string; trackScope: TrackScope | string }
): boolean {
  if (student.userIsActive !== true) return false;
  if (String(student.userStatus ?? "").toUpperCase() !== "ACTIVE") return false;
  if (student.groupIsActive !== true) return false;
  if (!student.groupCourseId || student.groupCourseId !== publication.courseId) return false;
  // `schoolType` is deliberately typed `unknown` above (the predicate must
  // fail closed on garbage, e.g. a legacy non-enum row); the Phase 12 helper
  // normalises whatever it receives, so this cast asserts nothing.
  return canAccessTrackScope(student.schoolType as string | null | undefined, publication.trackScope);
}

/**
 * THE eligible-recipient derivation. One query, sorted by userId (deterministic
 * chunks across retries). Callers:
 *   - the fan-out (delivery),
 *   - the admin recipients-preview endpoint (count),
 *   - the test-suite (both).
 * Returns the recipient projections (not just ids) so the caller can report
 * track composition without a second query.
 */
export async function getEligibleSessionRecipients(
  params: { courseId: string; trackScope: TrackScope | string },
  // Injected clients are structural, not nominal — same convention as
  // `getLessonReadiness` / `transitionLesson` (tests, CLI, and `db`).
  client: any = db
): Promise<SessionRecipient[]> {
  // FAIL CLOSED on an unrecognized scope: no rows (not "widen to SHARED").
  // The student-side rule (`canAccessTrackScope`) fails closed already, and
  // the query side must match it bit for bit rather than notify for a lesson
  // whose scope the platform cannot name.
  if (!normalizeTrackScope(params.trackScope)) return [];
  const rows = await client.student.findMany({
    where: sessionRecipientsWhere(params),
    select: { id: true, userId: true, schoolType: true },
  });
  const recipients: SessionRecipient[] = (rows as any[]).map((r) => ({
    studentId: String(r.id),
    userId: String(r.userId),
    schoolType:
      r.schoolType === "ARABIC" || r.schoolType === "LANGUAGE" ? r.schoolType : null,
  }));
  // Deterministic chunk boundaries: the same retry re-slices identically.
  recipients.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return recipients;
}

// ---------------------------------------------------------------------------
// Context resolution (lesson → targeting + template inputs)
// ---------------------------------------------------------------------------

const NOTIFICATION_LESSON_SELECT = {
  ...LESSON_CHAIN_SELECT,
  status: true,
  trackScope: true,
  officialCode: true,
  title: true,
  titleAr: true,
  unit: {
    select: {
      id: true,
      title: true,
      titleAr: true,
      part: { select: { id: true, courseId: true } },
    },
  },
  topic: {
    select: {
      id: true,
      unit: {
        select: {
          id: true,
          title: true,
          titleAr: true,
          part: { select: { id: true, courseId: true } },
        },
      },
    },
  },
  publication: { select: { id: true, segment: true, publishedAt: true } },
} as const;

export type SessionNotificationContext = {
  lessonId: string;
  status: string;
  trackScope: TrackScope;
  officialCode: string | null;
  title: string;
  titleAr: string | null;
  unitTitle: string | null;
  unitTitleAr: string | null;
  courseId: string | null;
  publication: { id: string; segment: string; publishedAt: Date | string } | null;
};

/**
 * Load the targeting/template context for a publication, or null when the
 * lesson does not exist. Publication presence and lifecycle state are DATA
 * here — the emission gate judges them (`emitSessionPublicationNotifications`),
 * never this loader, so the admin preview can render an honest "not ready"
 * answer for the same lesson.
 */
export async function getSessionNotificationContext(
  lessonId: string,
  client: any = db
): Promise<SessionNotificationContext | null> {
  const lesson = await client.lesson.findUnique({
    where: { id: lessonId },
    select: NOTIFICATION_LESSON_SELECT,
  });
  if (!lesson) return null;
  const unit = lesson.unit ?? lesson.topic?.unit ?? null;
  const courseId = resolveLessonCourseId(lesson as LessonChain);
  return {
    lessonId: String(lesson.id),
    status: String(lesson.status ?? "DRAFT"),
    trackScope: normalizeTrackScope(lesson.trackScope) ?? "SHARED",
    officialCode: lesson.officialCode ?? null,
    title: String(lesson.title ?? ""),
    titleAr: lesson.titleAr ?? null,
    unitTitle: unit?.title ?? null,
    unitTitleAr: unit?.titleAr ?? null,
    courseId,
    publication: lesson.publication
      ? {
          id: String(lesson.publication.id),
          segment: String(lesson.publication.segment),
          publishedAt: lesson.publication.publishedAt,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Localized templates
// ---------------------------------------------------------------------------

/**
 * The NEW_LESSON title/message in one locale. The strings live in the shared
 * dictionary (`api.230` / `api.231`) — never hardcoded here — and the
 * session/chapter names are picked from the lesson's own bilingual fields.
 */
export function renderSessionPublicationNotification(
  locale: Locale,
  ctx: Pick<
    SessionNotificationContext,
    "officialCode" | "title" | "titleAr" | "unitTitle" | "unitTitleAr"
  >
): { title: string; message: string } {
  // Blank strings count as MISSING here (same rule `translate` applies to
  // dictionary entries): a lesson whose Arabic title was imported as "" must
  // render the other language, never "جلسة جديدة: ".
  const blankToNull = (s: string | null | undefined) =>
    s && s.trim() ? s : null;
  const sessionName = pickL10n(locale, blankToNull(ctx.titleAr), blankToNull(ctx.title));
  const chapterName = pickL10n(locale, blankToNull(ctx.unitTitleAr), blankToNull(ctx.unitTitle));
  const display = ctx.officialCode ? `${ctx.officialCode} · ${sessionName}` : sessionName;
  return {
    title: translate(locale, "api.230", { p1: display }),
    message: translate(locale, "api.231", { p1: display, p2: chapterName || "-" }),
  };
}

// ---------------------------------------------------------------------------
// The fan-out
// ---------------------------------------------------------------------------
//
// Per-lesson in-process serialization: concurrent OPEN ceremonies of the same
// lesson queue their fan-outs, so the dedupe-check → createMany window can
// never interleave with itself. (The documented deployment is one standalone
// server; this lock is the whole guarantee there.)

const FAN_OUT_RUNS = new Map<string, Promise<SessionNotificationOutcome>>();

export type EmitSessionPublicationParams = {
  lessonId: string;
  actorUserId?: string | null;
  /** request locale for the title/message templates (default: platform `ar`) */
  locale?: Locale;
  /** injected clock — quiet hours + notifiedAt share one value per run */
  now?: Date;
  /** override the platform chunk size (default 500; clamped 1..1000) */
  chunkSize?: number;
  /** injected client — tests/CLI; production passes nothing and gets `db` */
  client?: any;
};

export function emitSessionPublicationNotifications(
  params: EmitSessionPublicationParams
): Promise<SessionNotificationOutcome> {
  const key = params.lessonId;
  const previous = FAN_OUT_RUNS.get(key) ?? Promise.resolve() as Promise<unknown>;
  const run: Promise<SessionNotificationOutcome> = previous
    .catch(() => undefined)
    .then(() => doEmitSessionPublicationNotifications(params));
  FAN_OUT_RUNS.set(key, run);
  run.finally(() => {
    if (FAN_OUT_RUNS.get(key) === run) FAN_OUT_RUNS.delete(key);
  });
  return run;
}

async function doEmitSessionPublicationNotifications(
  params: EmitSessionPublicationParams
): Promise<SessionNotificationOutcome> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const locale: Locale = params.locale === "en" ? "en" : "ar";
  const chunkSize = resolveNotificationChunkSize(params.chunkSize);
  const { lessonId, actorUserId = null } = params;

  const refusal = (
    code: SessionNotificationCode,
    message: string,
    partial: Partial<SessionNotificationOutcome> = {}
  ): SessionNotificationOutcome => ({
    ok: false,
    code,
    lessonId,
    publicationId: null,
    courseId: null,
    trackScope: null,
    eligible: 0,
    delivered: 0,
    alreadyNotified: 0,
    skippedPreference: 0,
    skippedQuietHours: 0,
    chunksPlanned: 0,
    chunksDone: 0,
    failedChunks: [],
    link: null,
    message,
    ...partial,
  });

  // ---- gate 1: the lesson, its lifecycle, its publication anchor ---------
  const ctx = await getSessionNotificationContext(lessonId, client);
  if (!ctx) {
    return refusal("LESSON_NOT_FOUND", "Lesson not found");
  }
  if (String(ctx.status).toUpperCase() !== "PUBLISHED") {
    return refusal("LESSON_NOT_PUBLISHED", "Lesson is not published", {
      publicationId: ctx.publication?.id ?? null,
      courseId: ctx.courseId,
      trackScope: ctx.trackScope,
    });
  }
  if (!ctx.publication) {
    // A PUBLISHED lesson with no live anchor means the publication was
    // withdrawn (or predates the platform): deliver NOTHING. Notifications
    // always follow a live publication, never a bare status.
    return refusal(
      "PUBLICATION_MISSING",
      "No live session publication; notification delivery refused",
      { courseId: ctx.courseId, trackScope: ctx.trackScope }
    );
  }
  if (!ctx.courseId) {
    return refusal(
      "LESSON_NOT_IN_COURSE",
      "The lesson belongs to no course; there is no audience to notify",
      { publicationId: ctx.publication.id, trackScope: ctx.trackScope }
    );
  }

  const link = sessionPublicationLink(lessonId);
  // The id comes from the database (a cuid in practice); if it somehow is not
  // link-safe we refuse rather than mint a malformed link.
  if (!link) {
    return refusal("LESSON_NOT_FOUND", "Lesson id cannot form a valid deep link", {
      publicationId: ctx.publication.id,
      courseId: ctx.courseId,
      trackScope: ctx.trackScope,
    });
  }

  // ---- gate 2: eligibility (THE shared derivation) ------------------------
  const recipients = await getEligibleSessionRecipients(
    { courseId: ctx.courseId, trackScope: ctx.trackScope },
    client
  );

  if (recipients.length === 0) {
    await auditPublicationNotify(client, actorUserId, lessonId, {
      code: "NO_RECIPIENTS",
      eligible: 0,
    });
    return refusal("NO_RECIPIENTS", "No eligible recipients for this publication", {
      publicationId: ctx.publication.id,
      courseId: ctx.courseId,
      trackScope: ctx.trackScope,
      link,
    });
  }

  // ---- gate 3: preferences (ONE bulk read, run-single clock) -------------
  const userIds = recipients.map((r) => r.userId);
  const prefRows = (await client.notificationPreference.findMany({
    where: { userId: { in: userIds } },
  })) as NotificationPreferenceRow[];
  const partition = partitionByNotificationPreferences(
    userIds,
    prefRows,
    SESSION_PUBLICATION_NOTIFICATION_TYPE,
    now
  );

  // ---- gate 4: chunked, deduped delivery ---------------------------------
  const { title, message } = renderSessionPublicationNotification(locale, ctx);
  const chunks = chunkList(partition.deliver, chunkSize);
  const failedChunks: number[] = [];
  let delivered = 0;
  let alreadyNotified = 0;
  let chunksDone = 0;

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    // Per-user delivery state for THIS chunk only: bounded IN () list, and
    // the rows users already hold ARE the idempotency state — the first run
    // claims them, every later attempt (retry, partial-chunk resume, NO_OP
    // ceremony replay) skips them.
    const existing = (await client.notification.findMany({
      where: {
        userId: { in: chunk },
        type: SESSION_PUBLICATION_NOTIFICATION_TYPE,
        link,
      },
      select: { userId: true },
    })) as Array<{ userId: string }>;
    const have = new Set(existing.map((r) => r.userId));
    const fresh = chunk.filter((userId) => !have.has(userId));
    alreadyNotified += chunk.length - fresh.length;

    if (fresh.length > 0) {
      try {
        await client.notification.createMany({
          data: fresh.map((userId) => ({
            userId,
            type: SESSION_PUBLICATION_NOTIFICATION_TYPE,
            title,
            message,
            link,
          })),
        });
        delivered += fresh.length;
      } catch (error) {
        // Chunk N failed: chunks N+1.. are NEVER attempted (sequential,
        // bounded work). The run reports EMITTED_PARTIAL; a retry re-runs the
        // whole pipeline and the dedupe above makes chunk 1..N-1 no-ops.
        failedChunks.push(index);
        break;
      }
    }
    chunksDone += 1;
  }

  // ---- persist the publication counters (DB-truth tally) ------------------
  const totalDelivered = await client.notification.count({
    where: { type: SESSION_PUBLICATION_NOTIFICATION_TYPE, link },
  });
  await client.sessionPublication.updateMany({
    where: { lessonId },
    data: {
      notifiedCount: totalDelivered,
      // Only a run that actually delivered rows moves the timestamp forward.
      ...(delivered > 0 ? { notifiedAt: now } : {}),
    },
  });

  // Terminal-code honesty: "already notified" is ONLY ever said when the
  // dedupe actually found a held row. When the whole audience was suppressed
  // by preferences/quiet hours the run attempted nothing, so it gets its own
  // code — never a reassuring-but-false ALREADY_DELIVERED.
  const code: SessionNotificationCode =
    failedChunks.length > 0
      ? "EMITTED_PARTIAL"
      : delivered > 0
        ? "EMITTED"
        : alreadyNotified > 0
          ? "ALREADY_DELIVERED"
          : "SUPPRESSED_BY_PREFERENCES";
  const outcomeMessage =
    code === "EMITTED_PARTIAL"
      ? `Chunk ${failedChunks[0]} of ${chunks.length} failed; ${delivered} delivered, retry resumes without duplicates`
      : code === "EMITTED"
        ? `Notified ${delivered} students`
        : code === "ALREADY_DELIVERED"
          ? "Every eligible student was already notified"
          : "Every eligible student is suppressed by their notification preferences or quiet hours; nothing was delivered";

  await auditPublicationNotify(client, actorUserId, lessonId, {
    code,
    eligible: recipients.length,
    delivered,
    alreadyNotified,
    skippedPreference: partition.skippedPreference,
    skippedQuietHours: partition.skippedQuietHours,
    chunksPlanned: chunks.length,
    chunksDone,
    failedChunks,
    totalDelivered,
  });

  return {
    ok: true,
    code,
    lessonId,
    publicationId: ctx.publication.id,
    courseId: ctx.courseId,
    trackScope: ctx.trackScope,
    eligible: recipients.length,
    delivered,
    alreadyNotified,
    skippedPreference: partition.skippedPreference,
    skippedQuietHours: partition.skippedQuietHours,
    chunksPlanned: chunks.length,
    chunksDone,
    failedChunks,
    link,
    message: outcomeMessage,
  };
}

/**
 * The operator-facing delivery log. Written AFTER the counts settle so one
 * row tells the whole story; a failed audit insert never fails a publication
 * (same rule the lifecycle ceremony uses).
 */
async function auditPublicationNotify(
  client: any,
  actorUserId: string | null,
  lessonId: string,
  details: Record<string, unknown>
): Promise<void> {
  if (!actorUserId) return;
  await client.auditLog
    .create({
      data: {
        userId: actorUserId,
        action: "LESSON_PUBLICATION_NOTIFY",
        entity: "SessionPublication",
        entityId: lessonId,
        details: JSON.stringify(details).slice(0, 1000),
      },
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Admin recipients preview (count == fan-out, by shared derivation)
// ---------------------------------------------------------------------------

export type SessionRecipientsPreview = {
  ok: boolean;
  code:
    | "OK"
    | "LESSON_NOT_FOUND"
    | "LESSON_NOT_IN_COURSE";
  lessonId: string;
  courseId: string | null;
  trackScope: TrackScope | null;
  status: string | null;
  publication: SessionNotificationContext["publication"];
  /** eligible students RIGHT NOW — the exact set the fan-out would derive */
  eligible: number;
  /** …of which already hold this publication's notification row */
  alreadyNotified: number;
  /**
   * The HONEST pending figure: rows a fan-out run would insert RIGHT NOW —
   * the preference partition's deliver set minus the rows already held. A
   * pref-disabled or in-quiet-hours student is "pending forever/until later",
   * never "about to be notified", and must not be counted as such.
   */
  pending: number;
  /** eligible minus pref/quiet suppressed — the partition's deliver set size */
  deliverableNow: number;
  /** eligible students currently suppressed by their own per-type flag */
  skippedPreferenceNow: number;
  /** eligible students currently inside their quiet-hours window */
  skippedQuietHoursNow: number;
  /** rows delivered so far per the publication anchor (0 before publish) */
  notifiedCount: number;
};

/**
 * The Open-dialog confirmation numbers. This is the SAME derivation as the
 * fan-out (`getEligibleSessionRecipients`) plus the same delivery-state check
 * — a count endpoint that ran a second query would be able to disagree, which
 * is exactly the defect the phase forbids.
 */
export async function previewSessionPublicationRecipients(
  lessonId: string,
  client: any = db
): Promise<SessionRecipientsPreview> {
  const ctx = await getSessionNotificationContext(lessonId, client);
  if (!ctx) {
    return {
      ok: false,
      code: "LESSON_NOT_FOUND",
      lessonId,
      courseId: null,
      trackScope: null,
      status: null,
      publication: null,
      eligible: 0,
      alreadyNotified: 0,
      pending: 0,
      deliverableNow: 0,
      skippedPreferenceNow: 0,
      skippedQuietHoursNow: 0,
      notifiedCount: 0,
    };
  }
  if (!ctx.courseId) {
    return {
      ok: false,
      code: "LESSON_NOT_IN_COURSE",
      lessonId,
      courseId: null,
      trackScope: ctx.trackScope,
      status: ctx.status,
      publication: ctx.publication,
      eligible: 0,
      alreadyNotified: 0,
      pending: 0,
      deliverableNow: 0,
      skippedPreferenceNow: 0,
      skippedQuietHoursNow: 0,
      notifiedCount: 0,
    };
  }
  const recipients = await getEligibleSessionRecipients(
    { courseId: ctx.courseId, trackScope: ctx.trackScope },
    client
  );
  const userIds = recipients.map((r) => r.userId);
  // The SAME preference partition the fan-out applies — a preview that
  // ignores preferences could promise a delivery the fan-out cannot make
  // ("5 will be notified" while 2 are suppressed), exactly the count-vs-
  // delivery disagreement this phase forbids.
  const prefRows = (await client.notificationPreference.findMany({
    where: { userId: { in: userIds } },
  })) as NotificationPreferenceRow[];
  const partition = partitionByNotificationPreferences(
    userIds,
    prefRows,
    SESSION_PUBLICATION_NOTIFICATION_TYPE,
    new Date()
  );
  const link = sessionPublicationLink(lessonId);
  const notified = link
    ? ((await client.notification.findMany({
        where: {
          userId: { in: userIds },
          type: SESSION_PUBLICATION_NOTIFICATION_TYPE,
          link,
        },
        select: { userId: true },
      })) as Array<{ userId: string }>)
    : [];
  const held = new Set(notified.map((n) => n.userId));
  const notifiedCount = ctx.publication
    ? await client.sessionPublication
        .findUnique({
          where: { lessonId },
          select: { notifiedCount: true },
        })
        .then((row: { notifiedCount: number } | null) => row?.notifiedCount ?? 0)
        .catch(() => 0)
    : 0;
  return {
    ok: true,
    code: "OK",
    lessonId,
    courseId: ctx.courseId,
    trackScope: ctx.trackScope,
    status: ctx.status,
    publication: ctx.publication,
    eligible: recipients.length,
    alreadyNotified: held.size,
    pending: partition.deliver.filter((u) => !held.has(u)).length,
    deliverableNow: partition.deliver.length,
    skippedPreferenceNow: partition.skippedPreference,
    skippedQuietHoursNow: partition.skippedQuietHours,
    notifiedCount,
  };
}
