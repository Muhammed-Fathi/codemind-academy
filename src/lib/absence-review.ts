// CodeMind Academy — Phase F absence-review service.
//
// THE WORKFLOW THIS MODULE OWNS
// =============================
//   finalized ABSENT row ─► AbsenceReview (PENDING_REASON)
//        student / linked parent submits a reason ─► PENDING_REVIEW
//        admin decides ─► EXCUSED | UNEXCUSED
//        admin corrects the attendance row ─► NO_ACTION_REQUIRED
//   and, for every decided case, the AbsenceHold Phase H consumes.
//
// HARD RULES
// ==========
//  * A case is born ONLY from a FINALIZED/LOCKED absence (never from a
//    temporary ABSENT click while the register is still editable) and exactly
//    once per attendance row (`AbsenceReview.attendanceId` is UNIQUE — the
//    database-level idempotency key of the whole workflow).
//  * UNMARKED students never appear here at all (no row → no case).
//  * Reasons are APPEND-ONLY (`AbsenceReasonSubmission`): replacing a reason
//    keeps the previous text and its author.
//  * Only an ADMIN decides; a teacher can never be reached by these functions.
//  * An EXCUSED decision does NOT unlock academic progression — it closes the
//    administrative review and RESOLVES the hold. Phase H owns catch-up access.
//
// See docs/PHASE_F_LIVE_SESSIONS_ATTENDANCE_ABSENCE.md.

import { db } from "@/lib/db";
import { pickL10n, translate } from "@/lib/i18n-core";
import {
  canDecide,
  canSubmitReason,
  holdStatusForDecision,
  normalizeAbsenceDecision,
  normalizeAbsenceQueueFilter,
  normalizeAbsenceReviewStatus,
  statusAfterReasonSubmission,
  statusForDecision,
  validateAbsenceReason,
  validateDecisionNote,
  type AbsenceDecision,
  type AbsenceQueueFilter,
  type AbsenceReviewStatusValue,
  type AbsenceSubmitterRole,
} from "@/lib/absence-policy";
import {
  evaluateRepeatedAbsence,
  repeatedAbsenceThreshold,
  repeatedAbsenceWindowDays,
  sessionDurationMinutes,
  sessionEndsAt,
} from "@/lib/live-session-policy";
import {
  notifyAbsenceDecision,
  notifyAbsenceFinalized,
  notifyAbsenceReasonSubmitted,
  insertNotificationOnce,
  parentUserIdsForStudents,
  type AbsenceNotificationContext,
} from "@/lib/live-session-notifications";

type Client = typeof db;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type AbsenceFailureCode =
  | "ABSENCE_NOT_FOUND"
  | "ABSENCE_ALREADY_DECIDED"
  | "ABSENCE_NOT_OPEN_FOR_REASON"
  | "ABSENCE_WINDOW_NOT_FINALIZED"
  | "NOT_AUTHORIZED"
  | "INVALID_DECISION"
  | "REASON_REQUIRED"
  | "REASON_TOO_SHORT"
  | "REASON_TOO_LONG"
  | "NOTE_TOO_LONG";

export class AbsenceError extends Error {
  code: AbsenceFailureCode;
  status: number;
  details?: Record<string, unknown>;
  constructor(code: AbsenceFailureCode, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "AbsenceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const ABSENCE_REVIEW_SELECT = {
  id: true,
  attendanceId: true,
  studentId: true,
  sessionId: true,
  groupId: true,
  lessonId: true,
  teacherId: true,
  status: true,
  reason: true,
  reasonSubmittedAt: true,
  reasonSubmittedByUserId: true,
  reasonSubmittedByRole: true,
  decidedByUserId: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
} as const;

// ---------------------------------------------------------------------------
// Case creation (idempotent) — the ONLY entry point
// ---------------------------------------------------------------------------

export type MaterializeResult = { created: number; existing: number };

/**
 * Turn the session's FINALIZED ABSENT rows into review cases.
 *
 * Idempotent by construction: the unique index on `attendanceId` plus an
 * explicit pre-check mean a retry (or a second finalize call) creates nothing.
 * Called from `finalizeAttendance` — the single place absence facts become
 * administrative work.
 */
export async function materializeAbsenceCases(params: {
  sessionId: string;
  actorUserId?: string | null;
  now?: Date;
  client?: Client;
}): Promise<MaterializeResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  const session = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: {
      id: true,
      groupId: true,
      lessonId: true,
      teacherId: true,
      substituteTeacherId: true,
      attendanceFinalizedAt: true,
      status: true,
      title: true,
      titleAr: true,
      startAt: true,
      duration: true,
    },
  })) as any;
  if (!session || !session.attendanceFinalizedAt) return { created: 0, existing: 0 };
  if (String(session.status ?? "").toUpperCase() === "CANCELLED") return { created: 0, existing: 0 };

  const absentRows = (await (client as any).attendance.findMany({
    where: { sessionId: params.sessionId, status: "ABSENT" },
    select: { id: true, studentId: true, status: true },
  })) as Array<{ id: string; studentId: string; status: string }>;
  if (absentRows.length === 0) return { created: 0, existing: 0 };

  const existing = (await (client as any).absenceReview.findMany({
    where: { attendanceId: { in: absentRows.map((r) => r.id) } },
    select: { attendanceId: true },
  })) as Array<{ attendanceId: string }>;
  const have = new Set(existing.map((r) => r.attendanceId));

  let created = 0;
  for (const row of absentRows) {
    if (have.has(row.id)) continue;
    try {
      await (client as any).absenceReview.create({
        data: {
          attendanceId: row.id,
          studentId: row.studentId,
          sessionId: session.id,
          groupId: session.groupId,
          lessonId: session.lessonId ?? null,
          teacherId: session.teacherId ?? session.substituteTeacherId ?? null,
          status: "PENDING_REASON",
        },
      });
      created += 1;
    } catch (error) {
      // A concurrent finalize may have won the race: the unique index turns
      // that into exactly the idempotent outcome we want.
      if (!/unique|constraint|duplicate/i.test(String((error as Error)?.message ?? ""))) throw error;
    }
  }

  if (created > 0) {
    const cases = (await (client as any).absenceReview.findMany({
      where: { sessionId: session.id, attendanceId: { in: absentRows.map((r) => r.id) } },
      select: { id: true, studentId: true },
    })) as Array<{ id: string; studentId: string }>;
    for (const c of cases) {
      await notifyAbsenceFinalized({
        ctx: await buildNotificationContext(c.id, client, session),
        now,
        client,
      });
    }
    await (client as any).auditLog
      .create({
        data: {
          userId: params.actorUserId || session.teacherId || "system",
          action: "ABSENCE_CASES_CREATED",
          entity: "LiveSession",
          entityId: session.id,
          details: JSON.stringify({ sessionId: session.id, created }).slice(0, 1000),
        },
      })
      .catch(() => undefined);
  }

  return { created, existing: absentRows.length - created };
}

async function buildNotificationContext(
  reviewId: string,
  client: Client,
  sessionOverride?: any
): Promise<AbsenceNotificationContext> {
  const review = (await (client as any).absenceReview.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      status: true,
      reason: true,
      studentId: true,
      sessionId: true,
      student: { select: { user: { select: { name: true } } } },
      session: {
        select: { id: true, title: true, titleAr: true, startAt: true, duration: true },
      },
    },
  })) as any;
  const session = sessionOverride ?? review?.session;
  return {
    reviewId: review?.id ?? reviewId,
    status: String(review?.status ?? "PENDING_REASON"),
    reason: review?.reason ?? null,
    sessionId: session?.id ?? review?.sessionId,
    sessionTitle: session?.title ?? "",
    sessionTitleAr: session?.titleAr ?? "",
    startAt: session?.startAt ?? new Date(),
    studentId: review?.studentId ?? "",
    studentName: review?.student?.user?.name ?? "",
  };
}

// ---------------------------------------------------------------------------
// Reader payloads
// ---------------------------------------------------------------------------

export type AbsenceCasePayload = {
  id: string;
  status: AbsenceReviewStatusValue;
  reason: string | null;
  reasonSubmittedAt: string | null;
  reasonSubmittedByRole: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  student: { id: string; name: string; studentCode: string | null; grade: string | null };
  session: {
    id: string;
    title: string;
    titleAr: string;
    startAt: string;
    endsAt: string;
    status: string;
  };
  lesson: { id: string; title: string; titleAr: string } | null;
  group: { id: string; name: string } | null;
  teacherName: string | null;
  hold: { status: string; createdAt: string; resolvedAt: string | null } | null;
  submissions: Array<{ id: string; reason: string; role: string; at: string; byName: string | null }>;
  flags: { repeatedAbsence: boolean; recentAbsentCount: number; threshold: number };
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toCasePayload(
  review: any,
  flags: { flagged: boolean; count: number; threshold: number }
): AbsenceCasePayload {
  const session = review.session ?? null;
  const endsAt = session ? sessionEndsAt(session) : null;
  return {
    id: String(review.id),
    status: normalizeAbsenceReviewStatus(review.status) ?? "PENDING_REASON",
    reason: review.reason ?? null,
    reasonSubmittedAt: iso(review.reasonSubmittedAt),
    reasonSubmittedByRole: review.reasonSubmittedByRole ?? null,
    decidedAt: iso(review.decidedAt),
    decisionNote: review.decisionNote ?? null,
    createdAt: iso(review.createdAt) ?? new Date(0).toISOString(),
    student: {
      id: String(review.studentId),
      name: review.student?.user?.name ?? "",
      studentCode: review.student?.studentCode ?? null,
      grade: review.student?.grade ?? null,
    },
    session: {
      id: String(review.sessionId),
      title: session?.title ?? "",
      titleAr: session?.titleAr ?? "",
      startAt: iso(session?.startAt) ?? new Date(0).toISOString(),
      endsAt: iso(endsAt) ?? new Date(0).toISOString(),
      status: String(session?.status ?? ""),
    },
    lesson: session?.lesson
      ? { id: session.lesson.id, title: session.lesson.title, titleAr: session.lesson.titleAr }
      : review.lessonId
        ? { id: String(review.lessonId), title: "", titleAr: "" }
        : null,
    group: review.group ? { id: review.group.id, name: review.group.name } : null,
    teacherName:
      review.session?.substituteTeacher?.user?.name ??
      review.session?.teacher?.user?.name ??
      null,
    hold: review.hold
      ? {
          status: String(review.hold.status),
          createdAt: iso(review.hold.createdAt) ?? "",
          resolvedAt: iso(review.hold.resolvedAt),
        }
      : null,
    submissions: (review.submissions ?? []).map((s: any) => ({
      id: String(s.id),
      reason: String(s.reason ?? ""),
      role: String(s.submittedByRole ?? ""),
      at: iso(s.createdAt) ?? "",
      byName: s.submittedBy?.name ?? null,
    })),
    flags: {
      repeatedAbsence: flags.flagged,
      recentAbsentCount: flags.count,
      threshold: flags.threshold,
    },
  };
}

const ABSENCE_WITH_CONTEXT = {
  ...ABSENCE_REVIEW_SELECT,
  student: { select: { id: true, studentCode: true, grade: true, user: { select: { name: true } } } },
  group: { select: { id: true, name: true } },
  hold: { select: { status: true, createdAt: true, resolvedAt: true } },
  submissions: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      reason: true,
      submittedByRole: true,
      createdAt: true,
      submittedByUserId: true,
    },
  },
  session: {
    select: {
      id: true,
      title: true,
      titleAr: true,
      startAt: true,
      duration: true,
      status: true,
      lesson: { select: { id: true, title: true, titleAr: true } },
      teacher: { select: { user: { select: { name: true } } } },
      substituteTeacher: { select: { user: { select: { name: true } } } },
    },
  },
} as const;

async function flagsForStudents(
  studentIds: string[],
  options: { now: Date; client: Client }
): Promise<Map<string, { flagged: boolean; count: number; threshold: number }>> {
  const out = new Map<string, { flagged: boolean; count: number; threshold: number }>();
  if (studentIds.length === 0) return out;
  const threshold = repeatedAbsenceThreshold();
  const windowDays = repeatedAbsenceWindowDays();
  const since = new Date(options.now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const rows = (await (options.client as any).absenceReview.findMany({
    where: {
      studentId: { in: studentIds },
      status: { in: ["PENDING_REASON", "PENDING_REVIEW", "UNEXCUSED"] },
    },
    select: { studentId: true, session: { select: { startAt: true } } },
  })) as Array<{ studentId: string; session: { startAt: Date | string } | null }>;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const at = row.session?.startAt ? new Date(row.session.startAt) : null;
    if (!at || at < since) continue;
    counts.set(row.studentId, (counts.get(row.studentId) ?? 0) + 1);
  }
  for (const studentId of studentIds) {
    out.set(studentId, evaluateRepeatedAbsence(counts.get(studentId) ?? 0, threshold));
  }
  return out;
}

async function hydrateCases(rows: any[], options: { now: Date; client: Client }) {
  const flags = await flagsForStudents(
    Array.from(new Set(rows.map((r) => String(r.studentId)))),
    options
  );
  const attribution = await resolveSubmissionAuthors(rows, options.client);
  return rows.map((row) => {
    const payload = toCasePayload(row, flags.get(String(row.studentId)) ?? evaluateRepeatedAbsence(0));
    payload.submissions = payload.submissions.map((s) => ({
      ...s,
      byName: attribution.get(s.id) ?? s.byName,
    }));
    return payload;
  });
}

/** Names for submission authors (one query; no per-row lookups). */
async function resolveSubmissionAuthors(
  rows: any[],
  client: Client
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const ids = new Set<string>();
  for (const row of rows) {
    for (const sub of row.submissions ?? []) {
      if (sub.submittedByUserId) ids.add(String(sub.submittedByUserId));
    }
  }
  if (ids.size === 0) return out;
  const users = (await (client as any).user.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  })) as Array<{ id: string; name: string }>;
  const byUser = new Map(users.map((u) => [u.id, u.name]));
  for (const row of rows) {
    for (const sub of row.submissions ?? []) {
      out.set(String(sub.id), sub.submittedByUserId ? byUser.get(String(sub.submittedByUserId)) ?? null : null);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Queue / listings
// ---------------------------------------------------------------------------

export type AbsenceQueueQuery = {
  status?: AbsenceQueueFilter | null;
  studentId?: string | null;
  groupId?: string | null;
  teacherId?: string | null;
  sessionId?: string | null;
  from?: Date | null;
  to?: Date | null;
  limit?: number;
};

export async function listAbsenceQueue(
  query: AbsenceQueueQuery,
  options: { now?: Date; client?: Client } = {}
): Promise<AbsenceCasePayload[]> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const filter = normalizeAbsenceQueueFilter(query.status ?? "ALL");
  if (filter === null) throw new AbsenceError("NOT_AUTHORIZED", "Unknown status filter", 400);

  const where: Record<string, unknown> = {};
  if (filter !== "ALL") where.status = filter;
  if (query.studentId) where.studentId = query.studentId;
  if (query.groupId) where.groupId = query.groupId;
  if (query.teacherId) where.teacherId = query.teacherId;
  if (query.sessionId) where.sessionId = query.sessionId;
  if (query.from || query.to) {
    where.session = {
      startAt: {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      },
    };
  }

  const rows = (await (client as any).absenceReview.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: query.limit ?? 100,
    select: ABSENCE_WITH_CONTEXT,
  })) as any[];
  return hydrateCases(rows, { now, client });
}

export async function countPendingAbsences(options: { client?: Client } = {}): Promise<number> {
  const client = options.client ?? db;
  const rows = (await (client as any).absenceReview.findMany({
    where: { status: { in: ["PENDING_REASON", "PENDING_REVIEW"] } },
    select: { id: true },
  })) as Array<{ id: string }>;
  return rows.length;
}

/** A student's own cases (student view). */
export async function listAbsencesForStudent(
  studentId: string,
  options: { now?: Date; client?: Client; limit?: number } = {}
): Promise<AbsenceCasePayload[]> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const rows = (await (client as any).absenceReview.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 50,
    select: ABSENCE_WITH_CONTEXT,
  })) as any[];
  return hydrateCases(rows, { now, client });
}

/** A parent's cases: ONLY for linked children (never another student). */
export async function listAbsencesForParent(
  parentId: string,
  options: { now?: Date; client?: Client; childId?: string | null; limit?: number } = {}
): Promise<AbsenceCasePayload[]> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const links = (await (client as any).parentStudentLink.findMany({
    where: { parentId },
    select: { studentId: true },
  })) as Array<{ studentId: string }>;
  const allowed = links.map((l) => l.studentId);
  if (allowed.length === 0) return [];
  const studentIds = options.childId && allowed.includes(options.childId) ? [options.childId] : allowed;
  const rows = (await (client as any).absenceReview.findMany({
    where: { studentId: { in: studentIds } },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 50,
    select: ABSENCE_WITH_CONTEXT,
  })) as any[];
  return hydrateCases(rows, { now, client });
}

export async function getAbsenceCase(
  reviewId: string,
  options: { now?: Date; client?: Client } = {}
): Promise<AbsenceCasePayload | null> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const row = (await (client as any).absenceReview.findUnique({
    where: { id: reviewId },
    select: ABSENCE_WITH_CONTEXT,
  })) as any;
  if (!row) return null;
  const [payload] = await hydrateCases([row], { now, client });
  return payload ?? null;
}

// ---------------------------------------------------------------------------
// Authorization helpers (called by the routes)
// ---------------------------------------------------------------------------

/** The linked student ids of a parent (one query; used for scope checks). */
export async function parentChildIds(parentId: string, client: Client = db): Promise<string[]> {
  const links = (await (client as any).parentStudentLink.findMany({
    where: { parentId },
    select: { studentId: true },
  })) as Array<{ studentId: string }>;
  return links.map((l) => l.studentId);
}

// ---------------------------------------------------------------------------
// Reason submission (student OR linked parent)
// ---------------------------------------------------------------------------

export type SubmitReasonResult = {
  case: AbsenceCasePayload;
  submissionId: string;
  status: AbsenceReviewStatusValue;
  notifiedAdmins: number;
};

/**
 * Append a reason. The route layer has ALREADY proven that the actor is the
 * case's own student or one of its linked parents (a teacher or an unrelated
 * parent can never reach this function). The service:
 *   1. validates the text (3..1000 chars, trimmed);
 *   2. refuses a decided case (a late reason is stored as history but does not
 *      reopen the decision — `canSubmitReason` returns false and the caller
 *      gets a 409 with the current status);
 *   3. mirrors the newest reason onto the case row (`reason`) while the
 *      submissions table keeps every previous one;
 *   4. notifies the admins (mandatory, idempotent per submission content).
 */
export async function submitAbsenceReason(params: {
  reviewId: string;
  actorUserId: string;
  actorRole: AbsenceSubmitterRole;
  reason: unknown;
  now?: Date;
  client?: Client;
}): Promise<SubmitReasonResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  const review = (await (client as any).absenceReview.findUnique({
    where: { id: params.reviewId },
    select: { id: true, status: true, studentId: true, sessionId: true },
  })) as { id: string; status: string; studentId: string; sessionId: string } | null;
  if (!review) throw new AbsenceError("ABSENCE_NOT_FOUND", "Absence case not found", 404);
  if (!canSubmitReason(review.status)) {
    throw new AbsenceError("ABSENCE_ALREADY_DECIDED", "This absence case is already decided", 409, {
      status: review.status,
    });
  }

  const validated = validateAbsenceReason(params.reason);
  if (!validated.ok) throw new AbsenceError(validated.code, "A valid reason is required", 400);

  const submission = (await (client as any).absenceReasonSubmission.create({
    data: {
      absenceReviewId: review.id,
      reason: validated.reason,
      submittedByUserId: params.actorUserId,
      submittedByRole: params.actorRole,
    },
  })) as { id: string };

  await (client as any).absenceReview.update({
    where: { id: review.id },
    data: {
      status: statusAfterReasonSubmission(review.status),
      reason: validated.reason,
      reasonSubmittedAt: now,
      reasonSubmittedByUserId: params.actorUserId,
      reasonSubmittedByRole: params.actorRole,
    },
  });

  await (client as any).auditLog
    .create({
      data: {
        userId: params.actorUserId,
        action: "ABSENCE_REASON_SUBMITTED",
        entity: "AbsenceReview",
        entityId: review.id,
        details: JSON.stringify({
          reviewId: review.id,
          sessionId: review.sessionId,
          role: params.actorRole,
          length: validated.reason.length,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  const notified = await notifyAbsenceReasonSubmitted({
    ctx: {
      ...(await buildNotificationContext(review.id, client)),
      reason: validated.reason,
    },
    now,
    client,
  });

  const payload = await getAbsenceCase(review.id, { now, client });
  return {
    case: payload as AbsenceCasePayload,
    submissionId: String(submission.id),
    status: statusAfterReasonSubmission(review.status),
    notifiedAdmins: notified.delivered,
  };
}

// ---------------------------------------------------------------------------
// The admin decision
// ---------------------------------------------------------------------------

export type DecideResult = {
  case: AbsenceCasePayload;
  decision: AbsenceDecision;
  hold: { status: string; id: string };
  notified: { delivered: number; duplicates: number };
};

/**
 * Decide a case: EXCUSE → EXCUSED + RESOLVED hold; UNEXCUSE → UNEXCUSED +
 * ACTIVE hold. Both write the hold (so Phase H has one uniform record), notify
 * the student and the linked parents, and audit the decision with the admin
 * identity and the timestamp.
 *
 * Decision Q is enforced by NOTHING here touching progression: no
 * LessonProgress row is written, no lesson is unlocked. Phase H consumes the
 * hold and owns catch-up access.
 */
export async function decideAbsence(params: {
  reviewId: string;
  adminUserId: string;
  decision: unknown;
  note?: unknown;
  now?: Date;
  client?: Client;
}): Promise<DecideResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  const decision = normalizeAbsenceDecision(params.decision);
  if (!decision) throw new AbsenceError("INVALID_DECISION", "Unknown decision", 400);
  const note = validateDecisionNote(params.note);
  if (!note.ok) throw new AbsenceError("NOTE_TOO_LONG", "The note is too long", 400);

  const review = (await (client as any).absenceReview.findUnique({
    where: { id: params.reviewId },
    select: { id: true, status: true, studentId: true, sessionId: true },
  })) as { id: string; status: string; studentId: string; sessionId: string } | null;
  if (!review) throw new AbsenceError("ABSENCE_NOT_FOUND", "Absence case not found", 404);
  if (!canDecide(review.status)) {
    throw new AbsenceError("ABSENCE_ALREADY_DECIDED", "This absence case already has a decision", 409, {
      status: review.status,
    });
  }

  const nextStatus = statusForDecision(decision);
  const holdState = holdStatusForDecision(decision);

  await (client as any).absenceReview.update({
    where: { id: review.id },
    data: {
      status: nextStatus,
      decidedByUserId: params.adminUserId,
      decidedAt: now,
      decisionNote: note.note,
    },
  });

  const existingHold = (await (client as any).absenceHold.findFirst({
    where: { absenceReviewId: review.id },
    select: { id: true },
  })) as { id: string } | null;

  let holdId: string;
  if (existingHold) {
    await (client as any).absenceHold.update({
      where: { id: existingHold.id },
      data: {
        status: holdState,
        reason: decision === "UNEXCUSE" ? "UNEXCUSED_ABSENCE" : "EXCUSED_ABSENCE",
        resolvedAt: holdState === "RESOLVED" ? now : null,
        resolvedByUserId: holdState === "RESOLVED" ? params.adminUserId : null,
        resolution: decision === "EXCUSE" ? "EXCUSED" : null,
      },
    });
    holdId = existingHold.id;
  } else {
    const hold = (await (client as any).absenceHold.create({
      data: {
        absenceReviewId: review.id,
        studentId: review.studentId,
        sessionId: review.sessionId,
        status: holdState,
        reason: decision === "UNEXCUSE" ? "UNEXCUSED_ABSENCE" : "EXCUSED_ABSENCE",
        resolvedAt: holdState === "RESOLVED" ? now : null,
        resolvedByUserId: holdState === "RESOLVED" ? params.adminUserId : null,
        resolution: decision === "EXCUSE" ? "EXCUSED" : null,
      },
    })) as { id: string };
    holdId = hold.id;
  }

  await (client as any).auditLog
    .create({
      data: {
        userId: params.adminUserId,
        action: decision === "EXCUSE" ? "ABSENCE_EXCUSED" : "ABSENCE_UNEXCUSED",
        entity: "AbsenceReview",
        entityId: review.id,
        details: JSON.stringify({
          reviewId: review.id,
          sessionId: review.sessionId,
          studentId: review.studentId,
          from: review.status,
          to: nextStatus,
          holdId,
          holdStatus: holdState,
          hasNote: Boolean(note.note),
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  const notified = await notifyAbsenceDecision({
    ctx: await buildNotificationContext(review.id, client),
    decision,
    now,
    client,
  });

  const payload = await getAbsenceCase(review.id, { now, client });
  return {
    case: payload as AbsenceCasePayload,
    decision,
    hold: { status: holdState, id: holdId },
    notified: { delivered: notified.delivered, duplicates: notified.duplicates },
  };
}

// ---------------------------------------------------------------------------
// Phase H bridge — CATCH-UP resolution of a hold (the ABSENCE authority stays
// the only writer of the hold)
// ---------------------------------------------------------------------------
//
// Phase H decides ACADEMIC catch-up (did the student complete the missed
// session's own requirements?) but the roadmap forbids it from mutating or
// bypassing the Phase F absence lifecycle. So Phase H calls THIS function,
// which lives next to the code that created the hold and writes it exactly
// once:
//
//   * only an ACTIVE hold is resolved (a RESOLVED one is a no-op, so a retried
//     request or a double-click can never produce a second audit row);
//   * the AbsenceReview STATUS IS NEVER TOUCHED — an UNEXCUSED decision stays
//     UNEXCUSED forever (history preserved), the hold merely stops blocking;
//   * the resolution is recorded with an actor + instant + reason, and is
//     mirrored into the platform AuditLog exactly once.
//
// `actorUserId` is NULLABLE on purpose: when the student's own academic work
// satisfied the catch-up there is no human actor, and inventing one would
// corrupt the audit trail.
export type CatchUpResolutionResult = {
  holdId: string | null;
  reviewId: string | null;
  studentId: string | null;
  /** True when THIS call moved the hold to RESOLVED. */
  resolved: boolean;
  /** True when the hold was already resolved beforehand (idempotent no-op). */
  alreadyResolved: boolean;
  /** True when a no-hold-to-resolve situation was found (nothing to do). */
  skipped: boolean;
};

export const HOLD_RESOLUTION_CATCH_UP = "CATCH_UP_COMPLETED";

export async function resolveAbsenceHoldForCatchUp(params: {
  studentId: string;
  holdId?: string | null;
  /** Restrict the search to the hold raised for THIS academic lesson. */
  lessonId?: string | null;
  actorUserId?: string | null;
  resolution?: string;
  now?: Date;
  client?: Client;
}): Promise<CatchUpResolutionResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  const hold = (await (client as any).absenceHold.findFirst({
    where: { studentId: params.studentId, status: "ACTIVE" },
    select: { id: true, status: true, absenceReviewId: true, studentId: true },
    orderBy: { createdAt: "asc" },
  })) as { id: string; status: string; absenceReviewId: string; studentId: string } | null;

  if (!hold) return { holdId: null, reviewId: null, studentId: null, resolved: false, alreadyResolved: false, skipped: true };
  if (String(hold.status ?? "").toUpperCase() !== "ACTIVE") {
    return {
      holdId: hold.id,
      reviewId: hold.absenceReviewId ?? null,
      studentId: hold.studentId,
      resolved: false,
      alreadyResolved: true,
      skipped: false,
    };
  }

  await (client as any).absenceHold.update({
    where: { id: hold.id },
    data: {
      status: "RESOLVED",
      resolvedAt: now,
      resolvedByUserId: params.actorUserId ?? null,
      resolution: params.resolution ?? HOLD_RESOLUTION_CATCH_UP,
    },
  });

  await (client as any).auditLog
    .create({
      data: {
        userId: params.actorUserId ?? hold.studentId,
        action: "ABSENCE_HOLD_RESOLVED_CATCH_UP",
        entity: "AbsenceHold",
        entityId: hold.id,
        details: JSON.stringify({
          holdId: hold.id,
          reviewId: hold.absenceReviewId ?? null,
          studentId: hold.studentId,
          lessonId: params.lessonId ?? null,
          resolution: params.resolution ?? HOLD_RESOLUTION_CATCH_UP,
          actorUserId: params.actorUserId ?? null,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return {
    holdId: hold.id,
    reviewId: hold.absenceReviewId ?? null,
    studentId: hold.studentId,
    resolved: true,
    alreadyResolved: false,
    skipped: false,
  };
}

// ---------------------------------------------------------------------------
// Attendance correction → the case is VOIDED (never silently deleted)
// ---------------------------------------------------------------------------

export async function voidAbsenceCaseForCorrection(params: {
  sessionId: string;
  studentId: string;
  adminUserId: string;
  now?: Date;
  client?: Client;
}): Promise<{ voided: boolean; reviewId: string | null; holdResolved: boolean }> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  const review = (await (client as any).absenceReview.findFirst({
    where: { sessionId: params.sessionId, studentId: params.studentId },
    select: { id: true, status: true },
  })) as { id: string; status: string } | null;
  if (!review) return { voided: false, reviewId: null, holdResolved: false };

  await (client as any).absenceReview.update({
    where: { id: review.id },
    data: {
      status: "NO_ACTION_REQUIRED",
      decidedByUserId: params.adminUserId,
      decidedAt: now,
      decisionNote: "ATTENDANCE_CORRECTED",
    },
  });

  const hold = (await (client as any).absenceHold.findFirst({
    where: { absenceReviewId: review.id },
    select: { id: true, status: true },
  })) as { id: string; status: string } | null;
  let holdResolved = false;
  if (hold && String(hold.status).toUpperCase() === "ACTIVE") {
    await (client as any).absenceHold.update({
      where: { id: hold.id },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolvedByUserId: params.adminUserId,
        resolution: "ATTENDANCE_CORRECTED",
      },
    });
    holdResolved = true;
  }

  await (client as any).auditLog
    .create({
      data: {
        userId: params.adminUserId,
        action: "ABSENCE_CASE_VOIDED",
        entity: "AbsenceReview",
        entityId: review.id,
        details: JSON.stringify({
          reviewId: review.id,
          sessionId: params.sessionId,
          from: review.status,
          to: "NO_ACTION_REQUIRED",
          holdResolved,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return { voided: true, reviewId: review.id, holdResolved };
}

// ---------------------------------------------------------------------------
// Repeated-absence signal (informational only)
// ---------------------------------------------------------------------------

/**
 * Every student with ≥ threshold finalized absences in the configured recent
 * window, with FACTUAL counts. Phase F attaches no consequence: no ban, no
 * suspension, no unenrollment, no label.
 */
export async function repeatedAbsenceFlags(options: {
  now?: Date;
  client?: Client;
} = {}): Promise<Array<{ studentId: string; studentName: string; count: number; threshold: number }>> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const threshold = repeatedAbsenceThreshold();
  const windowDays = repeatedAbsenceWindowDays();
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const rows = (await (client as any).absenceReview.findMany({
    where: { status: { in: ["PENDING_REASON", "PENDING_REVIEW", "UNEXCUSED"] } },
    select: {
      studentId: true,
      student: { select: { user: { select: { name: true } } } },
      session: { select: { startAt: true } },
    },
  })) as Array<{
    studentId: string;
    student: { user: { name: string } } | null;
    session: { startAt: Date | string } | null;
  }>;

  const counts = new Map<string, { count: number; name: string }>();
  for (const row of rows) {
    const at = row.session?.startAt ? new Date(row.session.startAt) : null;
    if (!at || at < since) continue;
    const entry = counts.get(row.studentId) ?? { count: 0, name: row.student?.user?.name ?? "" };
    entry.count += 1;
    entry.name = entry.name || row.student?.user?.name || "";
    counts.set(row.studentId, entry);
  }

  return [...counts.entries()]
    .map(([studentId, entry]) => ({ studentId, studentName: entry.name, count: entry.count, threshold }))
    .filter((row) => evaluateRepeatedAbsence(row.count, threshold).flagged)
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
// Reminders (idempotent; safe to run on a schedule)
// ---------------------------------------------------------------------------

export const ABSENCE_REMINDER_AFTER_HOURS_DEFAULT = 24;

export function absenceReminderAfterHours(env?: Record<string, string | undefined>): number {
  const raw =
    env?.ABSENCE_REMINDER_AFTER_HOURS ??
    (typeof process !== "undefined" ? process.env?.ABSENCE_REMINDER_AFTER_HOURS : undefined);
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return ABSENCE_REMINDER_AFTER_HOURS_DEFAULT;
  return Math.min(parsed, 24 * 14);
}

/**
 * Remind students (and linked parents) whose absence still has NO reason.
 *
 * Idempotency: the dedupe key is `<case>:<YYYY-MM-DD>` in the reminder's own
 * timezone-independent day bucket, so a cron re-run (or a manual trigger) on
 * the same day inserts nothing, while each following day may remind once more.
 */
export async function sendAbsenceReminders(options: {
  now?: Date;
  limit?: number;
  client?: Client;
} = {}): Promise<{ candidates: number; delivered: number; duplicates: number }> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const afterHours = absenceReminderAfterHours();
  const cutoff = new Date(now.getTime() - afterHours * 60 * 60 * 1000);
  const dayKey = now.toISOString().slice(0, 10);

  const rows = (await (client as any).absenceReview.findMany({
    where: { status: "PENDING_REASON" },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 200,
    select: {
      id: true,
      status: true,
      reason: true,
      studentId: true,
      sessionId: true,
      createdAt: true,
      student: { select: { userId: true, user: { select: { name: true } } } },
      session: { select: { id: true, title: true, titleAr: true, startAt: true } },
    },
  })) as any[];

  let candidates = 0;
  let delivered = 0;
  let duplicates = 0;

  for (const review of rows) {
    const createdAt = review.createdAt ? new Date(review.createdAt) : null;
    if (!createdAt || createdAt > cutoff) continue;
    candidates += 1;
    const parents = await parentUserIdsForStudents([review.studentId], client);
    const audience = Array.from(
      new Set([...(review.student?.userId ? [review.student.userId] : []), ...parents])
    ).sort();
    // Rendered at INSERT time (the platform default locale is Arabic) and
    // NEVER stored as a raw dictionary key — the UI must never show
    // `absence.notif.reminderTitle`.
    const sessionName = pickL10n(
      "ar",
      review.session?.titleAr ?? null,
      review.session?.title ?? null
    );
    const title = translate("ar", "absence.notif.reminderTitle", { p1: sessionName });
    const message = translate("ar", "absence.notif.reminderBody", { p1: sessionName });
    for (const userId of audience) {
      const result = await insertNotificationOnce(
        {
          userId,
          type: "ABSENCE_REMINDER",
          title,
          message,
          link: null,
          sessionId: review.sessionId,
          dedupeKey: `ABSENCE_REMINDER:${review.id}:${dayKey}`,
        },
        { mandatory: true, now, client }
      );
      if (result === "INSERTED") delivered += 1;
      else if (result === "DUPLICATE") duplicates += 1;
    }
  }

  return { candidates, delivered, duplicates };
}
