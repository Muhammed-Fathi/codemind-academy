// CodeMind Academy — Phase F LiveSession service.
//
// THE ONE AUTHORITY for the live-teaching workflow:
//
//   scheduling (admin + scoped teacher) → session link → upcoming sessions for
//   every role → the live period → the attendance register (server-derived
//   roster, open window, finalize) → the lock → admin corrections → the
//   operational queues.
//
// WHAT THIS MODULE OWNS (and what it deliberately does not)
// =========================================================
//   * SCOPE. Everything is resolved from the ACTOR's own rows
//     (`Group.teacherId` / `Group.courseId` / `Group.students` /
//     `LiveSession.substituteTeacherId`) and NEVER from a request parameter.
//     A teacher may schedule only inside their own groups/courses; a client
//     may never widen scope by supplying `teacherId`/`courseId`/`groupId`.
//   * WINDOWS. The join window and the attendance window come from
//     `src/lib/live-session-policy.ts` — one arithmetic, shared with the UI.
//   * THE ROSTER. Derived from `LiveSession.groupId → Group.students` on the
//     server for EVERY read and write; a client-supplied student list is never
//     trusted (it is not even read).
//   * UNMARKED ≠ ABSENT. A student without an `Attendance` row is UNMARKED.
//     Finalizing with unmarked students is possible ONLY with an explicit
//     acknowledgement, and it never converts them to ABSENT: the session is
//     flagged for admin review instead (`ATTENDANCE_INCOMPLETE`).
//   * THE LOCK. After the attendance window closes (or after finalization) a
//     teacher mutation is refused SERVER-SIDE; the only later writer is the
//     explicit admin correction ceremony.
//   * CANCELLED ≠ ABSENT. A cancelled session can never produce an attendance
//     fact or an absence case.
//
// Absence REVIEW (the administrative state machine) lives in
// `src/lib/absence-review.ts`; this module only hands it finalized absences.
// Notifications live in `src/lib/live-session-notifications.ts`.
//
// See docs/PHASE_F_LIVE_SESSIONS_ATTENDANCE_ABSENCE.md.

import { db } from "@/lib/db";
import {
  ATTENDANCE_STATUSES,
  decideAttendanceWrite,
  decideJoin,
  deriveSessionPhase,
  deriveSessionReviewState,
  liveSessionWindows,
  normalizeAttendanceStatus,
  normalizeSessionStatus,
  canTransitionSession,
  countAttendanceRows,
  isTerminalSessionStatus,
  meetingProviderLabelKey,
  sessionDurationMinutes,
  sessionEndsAt,
  sessionRevision,
  validateMeetingUrl,
  type AttendanceCounts,
  type AttendanceStatusValue,
  type LiveSessionPhase,
  type RosterStatusValue,
  type SessionReviewState,
  type SessionStatusValue,
} from "@/lib/live-session-policy";
import {
  notifySessionEvent,
  notifySessionLink,
  type SessionNotifyAudience,
} from "@/lib/live-session-notifications";

type Client = typeof db;

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export type LiveSessionFailureCode =
  | "SESSION_NOT_FOUND"
  | "GROUP_NOT_FOUND"
  | "GROUP_INACTIVE"
  | "LESSON_NOT_FOUND"
  | "LESSON_NOT_IN_GROUP_COURSE"
  | "TEACHER_NOT_FOUND"
  | "TEACHER_NOT_IN_SCOPE"
  | "NOT_AUTHORIZED"
  | "INVALID_TITLE"
  | "INVALID_START"
  | "INVALID_DURATION"
  | "INVALID_MEETING_URL"
  | "INVALID_STATUS_TRANSITION"
  | "SESSION_TERMINAL"
  | "ATTENDANCE_NOT_STARTED"
  | "ATTENDANCE_WINDOW_CLOSED"
  | "ATTENDANCE_ALREADY_FINALIZED"
  | "SESSION_CANCELLED"
  | "UNMARKED_REMAIN"
  | "STUDENT_NOT_IN_ROSTER"
  | "ATTENDANCE_NOT_FOUND"
  | "CORRECTION_REASON_REQUIRED"
  | "INVALID_STATUS";

export class LiveSessionError extends Error {
  code: LiveSessionFailureCode;
  status: number;
  details?: Record<string, unknown>;
  constructor(
    code: LiveSessionFailureCode,
    message: string,
    status = 400,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "LiveSessionError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type TeacherScope = {
  teacherId: string;
  userId: string;
  groupIds: string[];
  courseIds: string[];
  /** The same groups with the labels the UI needs (never client-supplied). */
  groups: Array<{ id: string; name: string; courseId: string }>;
};

/**
 * The signing-in teacher's scope, resolved from the DATABASE only.
 * `getTeacherProfile` (src/lib/api.ts) is the platform's single teacher
 * loader; this mirrors its shape without importing Next-bound helpers.
 */
export async function loadTeacherScope(
  userId: string,
  client: Client = db
): Promise<TeacherScope | null> {
  const teacher = (await (client as any).teacher.findUnique({
    where: { userId },
    include: { groups: { select: { id: true, name: true, courseId: true } } },
  })) as
    | { id: string; groups: Array<{ id: string; name: string; courseId: string }> }
    | null;
  if (!teacher) return null;
  return {
    teacherId: teacher.id,
    userId,
    groupIds: teacher.groups.map((g) => g.id),
    courseIds: Array.from(new Set(teacher.groups.map((g) => g.courseId))),
    groups: teacher.groups.map((g) => ({ id: g.id, name: g.name, courseId: g.courseId })),
  };
}

/** The columns every reader needs; one shape, one select. */
export const LIVE_SESSION_SELECT = {
  id: true,
  groupId: true,
  teacherId: true,
  substituteTeacherId: true,
  lessonId: true,
  title: true,
  titleAr: true,
  description: true,
  startAt: true,
  duration: true,
  meetingUrl: true,
  recordingUrl: true,
  status: true,
  createdAt: true,
  createdByUserId: true,
  statusChangedAt: true,
  statusChangedByUserId: true,
  conductedAt: true,
  endedAt: true,
  cancelledAt: true,
  cancelledByUserId: true,
  cancelReason: true,
  rescheduleCount: true,
  lastRescheduledAt: true,
  rescheduledByUserId: true,
  originalStartAt: true,
  substituteAssignedAt: true,
  substituteAssignedByUserId: true,
  attendanceFinalizedAt: true,
  attendanceFinalizedByUserId: true,
} as const;

// ---------------------------------------------------------------------------
// Serialization (one shape for every role; scope decides what is included)
// ---------------------------------------------------------------------------

export type LiveSessionPayload = {
  id: string;
  title: string;
  titleAr: string;
  description: string | null;
  startAt: string;
  duration: number;
  endsAt: string;
  status: SessionStatusValue;
  phase: LiveSessionPhase;
  reviewState: SessionReviewState;
  meetingProvider: string | null;
  meetingProviderLabelKey: string | null;
  /** True when the viewer may be handed the link RIGHT NOW. */
  joinAllowed: boolean;
  joinDenialCode: string | null;
  joinOpensAt: string;
  joinClosesAt: string;
  attendanceOpensAt: string;
  attendanceClosesAt: string;
  attendanceLocked: boolean;
  attendanceFinalizedAt: string | null;
  conductedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  rescheduleCount: number;
  originalStartAt: string | null;
  lastRescheduledAt: string | null;
  group: { id: string; name: string; courseId: string } | null;
  lesson: { id: string; title: string; titleAr: string } | null;
  teacher: { id: string; name: string } | null;
  substituteTeacher: { id: string; name: string } | null;
  counts?: AttendanceCounts;
};

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Serialize one session for a viewer. Never leaks a raw meeting URL. */
export function toLiveSessionPayload(params: {
  session: any;
  now: Date;
  counts?: AttendanceCounts;
}): LiveSessionPayload {
  const { session, now } = params;
  const windows = liveSessionWindows(session);
  const join = decideJoin(session, now);
  const write = decideAttendanceWrite(session, now);
  const link = validateMeetingUrl(session.meetingUrl);
  const counts = params.counts;
  return {
    id: String(session.id),
    title: String(session.title ?? ""),
    titleAr: String(session.titleAr ?? ""),
    description: session.description ?? null,
    startAt: toIso(session.startAt)!,
    duration: sessionDurationMinutes(session),
    endsAt: toIso(sessionEndsAt(session))!,
    status: normalizeSessionStatus(session.status) ?? "SCHEDULED",
    phase: deriveSessionPhase(session, now),
    reviewState: deriveSessionReviewState(session, { marked: counts?.marked ?? 0 }, now),
    meetingProvider: link.ok ? link.provider : null,
    meetingProviderLabelKey: link.ok ? meetingProviderLabelKey(link.provider) : null,
    joinAllowed: join.allowed,
    joinDenialCode: join.allowed ? null : join.code,
    joinOpensAt: toIso(windows.joinOpensAt)!,
    joinClosesAt: toIso(windows.joinClosesAt)!,
    attendanceOpensAt: toIso(windows.attendanceOpensAt)!,
    attendanceClosesAt: toIso(windows.attendanceClosesAt)!,
    attendanceLocked: write.allowed === false,
    attendanceFinalizedAt: toIso(session.attendanceFinalizedAt),
    conductedAt: toIso(session.conductedAt),
    cancelledAt: toIso(session.cancelledAt),
    cancelReason: session.cancelReason ?? null,
    rescheduleCount: Number(session.rescheduleCount ?? 0),
    originalStartAt: toIso(session.originalStartAt),
    lastRescheduledAt: toIso(session.lastRescheduledAt),
    group: session.group
      ? { id: session.group.id, name: session.group.name, courseId: session.group.courseId }
      : null,
    lesson: session.lesson
      ? { id: session.lesson.id, title: session.lesson.title, titleAr: session.lesson.titleAr }
      : null,
    teacher: session.teacher?.user
      ? { id: session.teacher.id, name: session.teacher.user.name }
      : session.teacher
        ? { id: session.teacher.id, name: "" }
        : null,
    substituteTeacher: session.substituteTeacher?.user
      ? { id: session.substituteTeacher.id, name: session.substituteTeacher.user.name }
      : session.substituteTeacher
        ? { id: session.substituteTeacher.id, name: "" }
        : null,
    ...(counts ? { counts } : {}),
  };
}

const SESSION_WITH_CONTEXT = {
  ...LIVE_SESSION_SELECT,
  group: { select: { id: true, name: true, courseId: true } },
  lesson: { select: { id: true, title: true, titleAr: true } },
  teacher: { select: { id: true, user: { select: { name: true } } } },
  substituteTeacher: { select: { id: true, user: { select: { name: true } } } },
} as const;

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export type SessionAccess = {
  session: any;
  /** How the actor reaches the session — used for UI copy + audit. */
  via: "ADMIN" | "OWNER_TEACHER" | "SUBSTITUTE_TEACHER";
};

/**
 * Load a session for a TEACHER, refusing anything outside their scope.
 *
 * Scope = owns the session's Group (teacherId) OR is its assigned SUBSTITUTE.
 * A substitute's authority is session-scoped and never becomes group
 * ownership.
 */
export async function loadSessionForTeacher(
  scope: TeacherScope,
  sessionId: string,
  client: Client = db
): Promise<SessionAccess> {
  const session = (await (client as any).liveSession.findUnique({
    where: { id: sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!session) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  if (session.substituteTeacherId && session.substituteTeacherId === scope.teacherId) {
    return { session, via: "SUBSTITUTE_TEACHER" };
  }
  if (session.groupId && scope.groupIds.includes(session.groupId)) {
    return { session, via: "OWNER_TEACHER" };
  }
  // Out-of-scope sessions answer the SAME 404 as ghosts: a session id is not
  // an existence oracle for teachers.
  throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
}

/** Load a session for a STUDENT: strict group membership. */
export async function loadSessionForStudent(
  studentId: string,
  sessionId: string,
  client: Client = db
): Promise<any> {
  const student = (await (client as any).student.findUnique({
    where: { id: studentId },
    select: { id: true, groupId: true },
  })) as { id: string; groupId: string | null } | null;
  const session = (await (client as any).liveSession.findUnique({
    where: { id: sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!student || !session || !student.groupId || session.groupId !== student.groupId) {
    throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  }
  return session;
}

/** Load a session for a PARENT: only through a linked child in that group. */
export async function loadSessionForParent(
  parentId: string,
  sessionId: string,
  client: Client = db
): Promise<{ session: any; studentId: string }> {
  const links = (await (client as any).parentStudentLink.findMany({
    where: { parentId },
    select: { studentId: true },
  })) as Array<{ studentId: string }>;
  const studentIds = links.map((l) => l.studentId);
  const session = (await (client as any).liveSession.findUnique({
    where: { id: sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!session || studentIds.length === 0) {
    throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  }
  const member = (await (client as any).student.findFirst({
    where: { id: { in: studentIds }, groupId: session.groupId },
    select: { id: true },
  })) as { id: string } | null;
  if (!member) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  return { session, studentId: member.id };
}

// ---------------------------------------------------------------------------
// Scheduling validation
// ---------------------------------------------------------------------------

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;

export type SessionDraft = {
  groupId: string;
  lessonId: string | null;
  title: string;
  titleAr: string;
  description: string | null;
  startAt: Date;
  duration: number;
  meetingUrl: string | null;
};

function parseBoundedText(raw: unknown, max: number, field: string): string {
  if (typeof raw !== "string") throw new LiveSessionError("INVALID_TITLE", `${field} is required`);
  const v = raw.replace(/\s+/g, " ").trim();
  if (v.length === 0) throw new LiveSessionError("INVALID_TITLE", `${field} is required`);
  if (v.length > max) throw new LiveSessionError("INVALID_TITLE", `${field} is too long`);
  return v;
}

/**
 * Parse + authorize a scheduling request. `actor` is either an ADMIN user id
 * or a resolved teacher scope; the group/lesson/teacher are all re-validated
 * against the DATABASE, so a forged request body cannot widen scope.
 */
export async function buildSessionDraft(params: {
  body: Record<string, unknown>;
  actor: { role: "ADMIN" | "TEACHER"; userId: string; scope?: TeacherScope | null };
  client?: Client;
}): Promise<SessionDraft> {
  const client = params.client ?? db;
  const body = params.body;
  const groupId = typeof body.groupId === "string" ? body.groupId.trim() : "";
  if (!groupId) throw new LiveSessionError("GROUP_NOT_FOUND", "Group is required", 400);

  const group = (await (client as any).group.findUnique({
    where: { id: groupId },
    select: { id: true, courseId: true, isActive: true, teacherId: true },
  })) as { id: string; courseId: string; isActive: boolean; teacherId: string | null } | null;
  if (!group) throw new LiveSessionError("GROUP_NOT_FOUND", "Group not found", 404);
  if (!group.isActive) throw new LiveSessionError("GROUP_INACTIVE", "Group is inactive", 409);

  if (params.actor.role === "TEACHER") {
    const scope = params.actor.scope;
    if (!scope || !scope.groupIds.includes(group.id)) {
      // A teacher may only schedule inside an assigned group; the group's
      // course is then implied and re-checked below.
      throw new LiveSessionError("TEACHER_NOT_IN_SCOPE", "You cannot schedule for this group", 403);
    }
  }

  const lessonIdRaw = typeof body.lessonId === "string" ? body.lessonId.trim() : "";
  let lessonId: string | null = null;
  if (lessonIdRaw) {
    const lesson = (await (client as any).lesson.findUnique({
      where: { id: lessonIdRaw },
      select: { id: true, title: true, titleAr: true },
    })) as { id: string; title: string; titleAr: string } | null;
    if (!lesson) throw new LiveSessionError("LESSON_NOT_FOUND", "Lesson not found", 404);
    // The academic Lesson must belong to the GROUP's course (canonical chain
    // first, legacy topic chain second) — scheduling a lesson outside the
    // group's course would attach students to content they cannot open.
    const inCourse = (await (client as any).lesson.findFirst({
      where: { id: lesson.id, OR: lessonChainForCourse(group.courseId) },
      select: { id: true },
    })) as { id: string } | null;
    if (!inCourse) {
      throw new LiveSessionError(
        "LESSON_NOT_IN_GROUP_COURSE",
        "The lesson is not part of this group's course",
        409
      );
    }
    lessonId = lesson.id;
  }

  const startRaw = body.startAt;
  const startAt = startRaw instanceof Date ? startRaw : new Date(String(startRaw ?? ""));
  if (!startRaw || Number.isNaN(startAt.getTime())) {
    throw new LiveSessionError("INVALID_START", "A valid start date/time is required", 400);
  }
  const durationParsed = Number(body.duration ?? 120);
  if (!Number.isFinite(durationParsed) || durationParsed < 15 || durationParsed > 600) {
    throw new LiveSessionError("INVALID_DURATION", "Duration must be 15..600 minutes", 400);
  }

  // Meeting link is OPTIONAL at creation (it can be added later and then
  // materializes a SESSION_LINK notification), but when supplied it must pass
  // the one validator.
  let meetingUrl: string | null = null;
  if (body.meetingUrl !== undefined && body.meetingUrl !== null && String(body.meetingUrl).trim() !== "") {
    const valid = validateMeetingUrl(body.meetingUrl);
    if (!valid.ok) throw new LiveSessionError("INVALID_MEETING_URL", "Invalid meeting URL", 400, { reason: valid.code });
    meetingUrl = valid.url;
  }

  let title = typeof body.title === "string" ? body.title.trim() : "";
  let titleAr = typeof body.titleAr === "string" ? body.titleAr.trim() : "";
  if (!title && !titleAr) {
    const lesson = lessonId
      ? ((await (client as any).lesson.findUnique({
          where: { id: lessonId },
          select: { title: true, titleAr: true },
        })) as { title: string; titleAr: string } | null)
      : null;
    title = lesson?.title ?? "";
    titleAr = lesson?.titleAr ?? "";
    if (!title && !titleAr) {
      throw new LiveSessionError("INVALID_TITLE", "A session title is required", 400);
    }
  }
  if (!titleAr) titleAr = title;
  if (!title) title = titleAr;
  title = parseBoundedText(title, TITLE_MAX, "title");
  titleAr = parseBoundedText(titleAr, TITLE_MAX, "titleAr");

  let description: string | null = null;
  if (typeof body.description === "string" && body.description.trim()) {
    const v = body.description.trim();
    if (v.length > DESCRIPTION_MAX) {
      throw new LiveSessionError("INVALID_TITLE", "description is too long", 400);
    }
    description = v;
  }

  return { groupId: group.id, lessonId, title, titleAr, description, startAt, duration: Math.floor(durationParsed), meetingUrl };
}

/**
 * The canonical + legacy chains that place a Lesson inside a course. Kept
 * local (and pure) so this module never depends on the progression engine:
 *   canonical: Lesson.unit.part.courseId
 *   legacy:    Lesson.topic.unit.part.courseId
 */
export function lessonChainForCourse(courseId: string): Array<Record<string, unknown>> {
  return [
    { unit: { part: { courseId } } },
    { topic: { unit: { part: { courseId } } } },
  ];
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function auditLiveSession(
  params: {
    userId: string;
    action: string;
    sessionId: string;
    details?: Record<string, unknown>;
  },
  client: Client = db
): Promise<void> {
  await (client as any).auditLog
    .create({
      data: {
        userId: params.userId,
        action: params.action,
        entity: "LiveSession",
        entityId: params.sessionId,
        details: JSON.stringify({ sessionId: params.sessionId, ...params.details }).slice(0, 1000),
      },
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Ceremonies: create / update / reschedule / cancel / substitute / start
// ---------------------------------------------------------------------------

export type CeremonyResult = {
  session: any;
  notifications: { event: string; delivered: number; duplicates: number; audience: number } | null;
};

function notifyOutcomeSummary(outcome: { event: string; delivered: number; duplicates: number; audience: number }) {
  return {
    event: outcome.event,
    delivered: outcome.delivered,
    duplicates: outcome.duplicates,
    audience: outcome.audience,
  };
}

/** Create a session (admin anywhere in their scope, teacher inside a group). */
export async function createLiveSession(params: {
  draft: SessionDraft;
  actor: { role: "ADMIN" | "TEACHER"; userId: string; scope?: TeacherScope | null };
  teacherId?: string | null;
  notify?: boolean;
  now?: Date;
  client?: Client;
}): Promise<CeremonyResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  // Teacher: the group's own teacher is authoritative — never a body value.
  // Admin: an explicit teacher (or none) is allowed; a substitute is a
  // SEPARATE ceremony (assignSubstituteTeacher) so the two never blur.
  let teacherId: string | null = null;
  if (params.actor.role === "TEACHER") {
    teacherId = params.actor.scope?.teacherId ?? null;
  } else if (params.teacherId) {
    const teacher = (await (client as any).teacher.findUnique({
      where: { id: params.teacherId },
      select: { id: true },
    })) as { id: string } | null;
    if (!teacher) throw new LiveSessionError("TEACHER_NOT_FOUND", "Teacher not found", 404);
    teacherId = teacher.id;
  } else {
    const group = (await (client as any).group.findUnique({
      where: { id: params.draft.groupId },
      select: { teacherId: true },
    })) as { teacherId: string | null } | null;
    teacherId = group?.teacherId ?? null;
  }

  const created = (await (client as any).liveSession.create({
    data: {
      groupId: params.draft.groupId,
      teacherId,
      lessonId: params.draft.lessonId,
      title: params.draft.title,
      titleAr: params.draft.titleAr,
      description: params.draft.description,
      startAt: params.draft.startAt,
      duration: params.draft.duration,
      meetingUrl: params.draft.meetingUrl,
      status: "SCHEDULED",
      createdByUserId: params.actor.userId,
      statusChangedAt: now,
      statusChangedByUserId: params.actor.userId,
      originalStartAt: params.draft.startAt,
    },
    select: SESSION_WITH_CONTEXT,
  })) as any;

  await auditLiveSession(
    {
      userId: params.actor.userId,
      action: "LIVE_SESSION_CREATE",
      sessionId: created.id,
      details: {
        groupId: created.groupId,
        lessonId: created.lessonId,
        startAt: created.startAt,
        duration: created.duration,
        hasMeetingUrl: Boolean(created.meetingUrl),
        actorRole: params.actor.role,
      },
    },
    client
  );

  let notifications: CeremonyResult["notifications"] = null;
  if (params.notify !== false) {
    const scheduled = await notifySessionEvent({
      kind: "SESSION_SCHEDULED",
      session: created,
      audience: "STUDENTS",
      now,
      client,
    });
    notifications = notifyOutcomeSummary(scheduled);
    if (created.meetingUrl) {
      // A session created WITH a link tells students the link is available —
      // the structured event that renders Join / Copy actions.
      await notifySessionLink({ session: created, now, client });
    }
  }

  return { session: created, notifications };
}

/** Metadata edits (title/description/link/time are separate ceremonies). */
export async function updateLiveSessionMeta(params: {
  sessionId: string;
  actorUserId: string;
  patch: { title?: string; titleAr?: string; description?: string | null };
  client?: Client;
}): Promise<any> {
  const client = params.client ?? db;
  const data: Record<string, unknown> = {};
  if (params.patch.title !== undefined) data.title = parseBoundedText(params.patch.title, TITLE_MAX, "title");
  if (params.patch.titleAr !== undefined) data.titleAr = parseBoundedText(params.patch.titleAr, TITLE_MAX, "titleAr");
  if (params.patch.description !== undefined) {
    const v = typeof params.patch.description === "string" ? params.patch.description.trim() : "";
    if (v.length > DESCRIPTION_MAX) throw new LiveSessionError("INVALID_TITLE", "description is too long");
    data.description = v || null;
  }
  if (Object.keys(data).length === 0) {
    const current = (await (client as any).liveSession.findUnique({
      where: { id: params.sessionId },
      select: SESSION_WITH_CONTEXT,
    })) as any;
    if (!current) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
    return current;
  }
  const updated = (await (client as any).liveSession.update({
    where: { id: params.sessionId },
    data,
    select: SESSION_WITH_CONTEXT,
  })) as any;
  await auditLiveSession(
    {
      userId: params.actorUserId,
      action: "LIVE_SESSION_UPDATE",
      sessionId: updated.id,
      details: { fields: Object.keys(data) },
    },
    client
  );
  return updated;
}

/**
 * Set or change the Session Link. A MATERIAL change (a different validated
 * URL) emits the structured SESSION_LINK notification; an unchanged link is a
 * no-op and emits nothing (idempotent by revision).
 */
export async function setSessionLink(params: {
  sessionId: string;
  actorUserId: string;
  meetingUrl: unknown;
  notify?: boolean;
  now?: Date;
  client?: Client;
}): Promise<CeremonyResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const current = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!current) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  if (isTerminalSessionStatus(current.status)) {
    throw new LiveSessionError("SESSION_TERMINAL", "A completed or cancelled session cannot change its link", 409);
  }

  let next: string | null = null;
  if (params.meetingUrl !== null && params.meetingUrl !== undefined && String(params.meetingUrl).trim() !== "") {
    const valid = validateMeetingUrl(params.meetingUrl);
    if (!valid.ok) {
      throw new LiveSessionError("INVALID_MEETING_URL", "Invalid meeting URL", 400, { reason: valid.code });
    }
    next = valid.url;
  }

  const changed = (current.meetingUrl ?? null) !== next;
  const updated = (await (client as any).liveSession.update({
    where: { id: params.sessionId },
    data: { meetingUrl: next },
    select: SESSION_WITH_CONTEXT,
  })) as any;

  if (changed) {
    await auditLiveSession(
      {
        userId: params.actorUserId,
        action: "LIVE_SESSION_LINK_CHANGE",
        sessionId: updated.id,
        details: { hadLink: Boolean(current.meetingUrl), hasLink: Boolean(next) },
      },
      client
    );
  }

  let notifications: CeremonyResult["notifications"] = null;
  if (changed && next && params.notify !== false) {
    const outcome = await notifySessionLink({ session: updated, now, client });
    notifications = notifyOutcomeSummary(outcome);
  }
  return { session: updated, notifications };
}

/**
 * Reschedule: the schedule is replaced, the HISTORY is preserved
 * (`originalStartAt` keeps the first instant forever, `rescheduleCount`
 * counts the ceremonies, every ceremony is audited) and a
 * SESSION_RESCHEDULED notification goes to students AND their linked parents.
 */
export async function rescheduleLiveSession(params: {
  sessionId: string;
  actorUserId: string;
  startAt: unknown;
  duration?: unknown;
  reason?: string | null;
  notify?: boolean;
  now?: Date;
  client?: Client;
}): Promise<CeremonyResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const current = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!current) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  if (isTerminalSessionStatus(current.status)) {
    throw new LiveSessionError("SESSION_TERMINAL", "A completed or cancelled session cannot be rescheduled", 409);
  }

  const startAt = params.startAt instanceof Date ? params.startAt : new Date(String(params.startAt ?? ""));
  if (!params.startAt || Number.isNaN(startAt.getTime())) {
    throw new LiveSessionError("INVALID_START", "A valid start date/time is required", 400);
  }
  let duration = sessionDurationMinutes(current);
  if (params.duration !== undefined && params.duration !== null && String(params.duration) !== "") {
    const parsed = Number(params.duration);
    if (!Number.isFinite(parsed) || parsed < 15 || parsed > 600) {
      throw new LiveSessionError("INVALID_DURATION", "Duration must be 15..600 minutes", 400);
    }
    duration = Math.floor(parsed);
  }

  const updated = (await (client as any).liveSession.update({
    where: { id: params.sessionId },
    data: {
      startAt,
      duration,
      originalStartAt: current.originalStartAt ?? current.startAt,
      rescheduleCount: Number(current.rescheduleCount ?? 0) + 1,
      lastRescheduledAt: now,
      rescheduledByUserId: params.actorUserId,
    },
    select: SESSION_WITH_CONTEXT,
  })) as any;

  await auditLiveSession(
    {
      userId: params.actorUserId,
      action: "LIVE_SESSION_RESCHEDULE",
      sessionId: updated.id,
      details: {
        from: toIso(current.startAt),
        to: toIso(updated.startAt),
        duration,
        reason: params.reason ?? null,
        revision: sessionRevision(updated),
      },
    },
    client
  );

  let notifications: CeremonyResult["notifications"] = null;
  if (params.notify !== false) {
    const outcome = await notifySessionEvent({
      kind: "SESSION_RESCHEDULED",
      session: updated,
      audience: "STUDENTS_AND_PARENTS",
      now,
      client,
    });
    notifications = notifyOutcomeSummary(outcome);
  }
  return { session: updated, notifications };
}

/**
 * Cancel. A cancelled session is TERMINAL: it can never produce attendance
 * facts (the register refuses writes), never produces absence cases, and the
 * student/parent audience is told explicitly.
 */
export async function cancelLiveSession(params: {
  sessionId: string;
  actorUserId: string;
  reason?: string | null;
  notify?: boolean;
  now?: Date;
  client?: Client;
}): Promise<CeremonyResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const current = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!current) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  if (!canTransitionSession(current.status, "CANCELLED")) {
    throw new LiveSessionError(
      "INVALID_STATUS_TRANSITION",
      "This session cannot be cancelled from its current state",
      409
    );
  }

  const reason =
    typeof params.reason === "string" && params.reason.trim() ? params.reason.trim().slice(0, 500) : null;

  const updated = (await (client as any).liveSession.update({
    where: { id: params.sessionId },
    data: {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledByUserId: params.actorUserId,
      cancelReason: reason,
      statusChangedAt: now,
      statusChangedByUserId: params.actorUserId,
    },
    select: SESSION_WITH_CONTEXT,
  })) as any;

  await auditLiveSession(
    {
      userId: params.actorUserId,
      action: "LIVE_SESSION_CANCEL",
      sessionId: updated.id,
      details: { from: String(current.status), reason },
    },
    client
  );

  let notifications: CeremonyResult["notifications"] = null;
  if (params.notify !== false) {
    const outcome = await notifySessionEvent({
      kind: "SESSION_CANCELLED",
      session: updated,
      audience: "STUDENTS_AND_PARENTS",
      now,
      client,
    });
    notifications = notifyOutcomeSummary(outcome);
  }
  return { session: updated, notifications };
}

/**
 * Assign (or clear) a SUBSTITUTE teacher for ONE session. Never transfers
 * group/course ownership, never rewrites `teacherId`, and the substitution is
 * audited. The substitute may then view/join/start the session and take its
 * attendance inside the normal window.
 */
export async function assignSubstituteTeacher(params: {
  sessionId: string;
  actorUserId: string;
  substituteTeacherId: string | null;
  notify?: boolean;
  now?: Date;
  client?: Client;
}): Promise<CeremonyResult> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const current = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!current) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  if (isTerminalSessionStatus(current.status)) {
    throw new LiveSessionError("SESSION_TERMINAL", "A completed or cancelled session cannot be reassigned", 409);
  }

  let substituteId: string | null = null;
  if (params.substituteTeacherId) {
    const teacher = (await (client as any).teacher.findUnique({
      where: { id: params.substituteTeacherId },
      select: { id: true },
    })) as { id: string } | null;
    if (!teacher) throw new LiveSessionError("TEACHER_NOT_FOUND", "Teacher not found", 404);
    substituteId = teacher.id;
  }

  const updated = (await (client as any).liveSession.update({
    where: { id: params.sessionId },
    data: {
      substituteTeacherId: substituteId,
      substituteAssignedAt: substituteId ? now : null,
      substituteAssignedByUserId: substituteId ? params.actorUserId : null,
    },
    select: SESSION_WITH_CONTEXT,
  })) as any;

  await auditLiveSession(
    {
      userId: params.actorUserId,
      action: "LIVE_SESSION_SUBSTITUTE_ASSIGN",
      sessionId: updated.id,
      details: {
        previous: current.substituteTeacherId ?? null,
        substituteTeacherId: substituteId,
      },
    },
    client
  );

  let notifications: CeremonyResult["notifications"] = null;
  if (params.notify !== false && substituteId) {
    const outcome = await notifySessionEvent({
      kind: "SESSION_RESCHEDULED",
      session: updated,
      audience: "STUDENTS",
      now,
      client,
    });
    notifications = notifyOutcomeSummary(outcome);
  }
  return { session: updated, notifications };
}

/**
 * The teacher starts the live period: SCHEDULED → LIVE plus the
 * `conductedAt` marker that tells the admin queues "the class actually
 * happened". Only legal before the session is terminal.
 */
export async function startLiveSession(params: {
  sessionId: string;
  actorUserId: string;
  now?: Date;
  client?: Client;
}): Promise<any> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const current = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!current) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  if (normalizeSessionStatus(current.status) === "SCHEDULED") {
    if (!canTransitionSession(current.status, "LIVE")) {
      throw new LiveSessionError("INVALID_STATUS_TRANSITION", "This session cannot be started", 409);
    }
    const updated = (await (client as any).liveSession.update({
      where: { id: params.sessionId },
      data: {
        status: "LIVE",
        conductedAt: current.conductedAt ?? now,
        statusChangedAt: now,
        statusChangedByUserId: params.actorUserId,
      },
      select: SESSION_WITH_CONTEXT,
    })) as any;
    await auditLiveSession(
      {
        userId: params.actorUserId,
        action: "LIVE_SESSION_START",
        sessionId: updated.id,
        details: { from: String(current.status) },
      },
      client
    );
    return updated;
  }
  if (normalizeSessionStatus(current.status) === "LIVE") {
    // Idempotent: a second start only records the conducted marker if missing.
    if (!current.conductedAt) {
      return (await (client as any).liveSession.update({
        where: { id: params.sessionId },
        data: { conductedAt: now },
        select: SESSION_WITH_CONTEXT,
      })) as any;
    }
    return current;
  }
  throw new LiveSessionError("SESSION_TERMINAL", "This session is already finished", 409);
}

/** The teacher ends the live period (informational; never moves the lock). */
export async function endLiveSession(params: {
  sessionId: string;
  actorUserId: string;
  now?: Date;
  client?: Client;
}): Promise<any> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const current = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!current) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  if (!canTransitionSession(current.status, "COMPLETED")) {
    throw new LiveSessionError("INVALID_STATUS_TRANSITION", "This session cannot be ended", 409);
  }
  const updated = (await (client as any).liveSession.update({
    where: { id: params.sessionId },
    data: {
      status: "COMPLETED",
      endedAt: now,
      conductedAt: current.conductedAt ?? now,
      statusChangedAt: now,
      statusChangedByUserId: params.actorUserId,
    },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  await auditLiveSession(
    {
      userId: params.actorUserId,
      action: "LIVE_SESSION_END",
      sessionId: updated.id,
      details: { from: String(current.status) },
    },
    client
  );
  return updated;
}

// ---------------------------------------------------------------------------
// Roster & attendance
// ---------------------------------------------------------------------------

export type RosterRow = {
  studentId: string;
  userId: string | null;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  studentCode: string | null;
  grade: string | null;
  status: RosterStatusValue;
  rawStatus: AttendanceStatusValue | null;
  note: string | null;
  attendanceId: string | null;
  markedAt: string | null;
  /** Finalized rows are immutable to the teacher. */
  locked: boolean;
  overallPct: number | null;
  overallTotal: number;
};

/**
 * The REAL roster: `LiveSession.groupId → Group.students` (active students),
 * joined with their attendance rows for THIS session. A client-supplied list
 * is never read — a forged student id is refused by `saveAttendance` because
 * it is not in this set.
 */
export async function loadSessionRoster(
  sessionId: string,
  options: { client?: Client; now?: Date } = {}
): Promise<{ rows: RosterRow[]; counts: AttendanceCounts }> {
  const client = options.client ?? db;
  const session = (await (client as any).liveSession.findUnique({
    where: { id: sessionId },
    select: { id: true, groupId: true, attendanceFinalizedAt: true },
  })) as { id: string; groupId: string; attendanceFinalizedAt: Date | string | null } | null;
  if (!session) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);

  const students = (await (client as any).student.findMany({
    where: { groupId: session.groupId, user: { isActive: true } },
    select: {
      id: true,
      userId: true,
      studentCode: true,
      grade: true,
      user: { select: { name: true, email: true, avatarUrl: true } },
    },
  })) as Array<{
    id: string;
    userId: string;
    studentCode: string | null;
    grade: string | null;
    user: { name: string; email: string | null; avatarUrl: string | null } | null;
  }>;

  const attendanceRows = (await (client as any).attendance.findMany({
    where: { sessionId },
    select: { id: true, studentId: true, status: true, note: true, markedAt: true },
  })) as Array<{
    id: string;
    studentId: string;
    status: AttendanceStatusValue;
    note: string | null;
    markedAt: Date | string | null;
  }>;
  const byStudent = new Map(attendanceRows.map((r) => [r.studentId, r]));

  // Per-student attendance history across the group (the existing teacher
  // screen's "%" column) — one query, no N+1.
  const groupSessions = (await (client as any).liveSession.findMany({
    where: { groupId: session.groupId },
    select: { id: true },
  })) as Array<{ id: string }>;
  const groupSessionIds = groupSessions.map((s) => s.id);
  const history = groupSessionIds.length
    ? ((await (client as any).attendance.findMany({
        where: { sessionId: { in: groupSessionIds } },
        select: { studentId: true, status: true },
      })) as Array<{ studentId: string; status: AttendanceStatusValue }>)
    : [];
  const stats = new Map<string, { total: number; present: number }>();
  for (const row of history) {
    const entry = stats.get(row.studentId) ?? { total: 0, present: 0 };
    entry.total += 1;
    if (row.status === "PRESENT" || row.status === "LATE") entry.present += 1;
    stats.set(row.studentId, entry);
  }

  const locked = Boolean(session.attendanceFinalizedAt);
  const rows: RosterRow[] = students
    .map((s) => {
      const row = byStudent.get(s.id) ?? null;
      const stat = stats.get(s.id) ?? { total: 0, present: 0 };
      return {
        studentId: s.id,
        userId: s.userId ?? null,
        name: s.user?.name ?? "",
        email: s.user?.email ?? null,
        avatarUrl: s.user?.avatarUrl ?? null,
        studentCode: s.studentCode ?? null,
        grade: s.grade ?? null,
        status: row ? (normalizeAttendanceStatus(row.status) ?? "UNMARKED") : "UNMARKED",
        rawStatus: row ? normalizeAttendanceStatus(row.status) : null,
        note: row?.note ?? null,
        attendanceId: row?.id ?? null,
        markedAt: row?.markedAt ? toIso(row.markedAt) : null,
        locked,
        overallPct: stat.total > 0 ? Math.round((stat.present / stat.total) * 100) : null,
        overallTotal: stat.total,
      } satisfies RosterRow;
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ar"));

  return { rows, counts: countAttendanceRows(rows) };
}

export type AttendanceEntry = { studentId: string; status: AttendanceStatusValue; note?: string | null };

/**
 * Write attendance. SERVER-SIDE GATES, in order:
 *   1. the session must exist and be in an open, non-cancelled window;
 *   2. every student id must be on the REAL roster (group membership);
 *   3. the status must be a known fact;
 *   4. UNMARKED is expressed by OMITTING the entry (or by clearing) — never
 *      by writing ABSENT.
 *
 * The window check is the ONLY authority: a teacher cannot mark before the
 * scheduled start, and cannot mark after the window closes (or after the
 * register was finalized). UI hiding is not a security control; this is.
 */
export async function saveAttendance(params: {
  sessionId: string;
  actorUserId: string;
  entries: AttendanceEntry[];
  now?: Date;
  client?: Client;
}): Promise<{ saved: number; counts: AttendanceCounts; closesAt: string }> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  const session = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: { id: true, groupId: true, startAt: true, duration: true, status: true, attendanceFinalizedAt: true },
  })) as any;
  if (!session) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);

  const decision = decideAttendanceWrite(session, now);
  if (!decision.allowed) {
    const map: Record<string, [LiveSessionFailureCode, number, string]> = {
      NOT_STARTED: ["ATTENDANCE_NOT_STARTED", 409, "Attendance opens when the session starts"],
      WINDOW_CLOSED: ["ATTENDANCE_WINDOW_CLOSED", 409, "The attendance window for this session is closed"],
      ALREADY_FINALIZED: ["ATTENDANCE_ALREADY_FINALIZED", 409, "Attendance was finalized and is now locked"],
      SESSION_CANCELLED: ["SESSION_CANCELLED", 409, "A cancelled session has no attendance"],
    };
    const [code, status, message] = map[decision.code] ?? ["ATTENDANCE_WINDOW_CLOSED", 409, "Attendance is locked"];
    throw new LiveSessionError(code, message, status, { closesAt: toIso(decision.closesAt) });
  }

  if (params.entries.length === 0) {
    const counts = (await loadSessionRoster(params.sessionId, { client, now })).counts;
    return { saved: 0, counts, closesAt: toIso(decision.closesAt)! };
  }

  // The roster is the authority — a client list can only NARROW it.
  const rosterIds = new Set(
    (
      (await (client as any).student.findMany({
        where: { groupId: session.groupId },
        select: { id: true },
      })) as Array<{ id: string }>
    ).map((s) => s.id)
  );

  const seen = new Set<string>();
  for (const entry of params.entries) {
    const studentId = String(entry.studentId ?? "");
    if (!studentId || seen.has(studentId)) continue;
    seen.add(studentId);
    if (!rosterIds.has(studentId)) {
      throw new LiveSessionError("STUDENT_NOT_IN_ROSTER", "That student is not in this group", 403);
    }
    const status = normalizeAttendanceStatus(entry.status);
    if (!status) throw new LiveSessionError("INVALID_STATUS", "Unknown attendance status", 400);
    const note =
      typeof entry.note === "string" && entry.note.trim() ? entry.note.trim().slice(0, 500) : null;
    await (client as any).attendance.upsert({
      where: { studentId_sessionId: { studentId, sessionId: params.sessionId } },
      update: { status, note, markedByUserId: params.actorUserId, markedAt: now },
      create: {
        studentId,
        sessionId: params.sessionId,
        status,
        note,
        markedByUserId: params.actorUserId,
        markedAt: now,
      },
    });
  }

  await auditLiveSession(
    {
      userId: params.actorUserId,
      action: "LIVE_SESSION_ATTENDANCE_SAVE",
      sessionId: params.sessionId,
      details: { entries: params.entries.length },
    },
    client
  );

  const { counts } = await loadSessionRoster(params.sessionId, { client, now });
  return { saved: params.entries.length, counts, closesAt: toIso(decision.closesAt)! };
}

/** Explicitly clear a mark back to UNMARKED (inside the window only). */
export async function clearAttendanceMark(params: {
  sessionId: string;
  actorUserId: string;
  studentId: string;
  now?: Date;
  client?: Client;
}): Promise<{ cleared: boolean }> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const session = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: { id: true, groupId: true, startAt: true, duration: true, status: true, attendanceFinalizedAt: true },
  })) as any;
  if (!session) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  const decision = decideAttendanceWrite(session, now);
  if (!decision.allowed) {
    const code: LiveSessionFailureCode =
      decision.code === "ALREADY_FINALIZED"
        ? "ATTENDANCE_ALREADY_FINALIZED"
        : decision.code === "SESSION_CANCELLED"
          ? "SESSION_CANCELLED"
          : "ATTENDANCE_WINDOW_CLOSED";
    throw new LiveSessionError(code, "Attendance is locked", 409);
  }
  const existing = (await (client as any).attendance.findFirst({
    where: { sessionId: params.sessionId, studentId: params.studentId },
    select: { id: true },
  })) as { id: string } | null;
  if (!existing) return { cleared: false };
  await (client as any).attendance.delete({ where: { id: existing.id } });
  await auditLiveSession(
    {
      userId: params.actorUserId,
      action: "LIVE_SESSION_ATTENDANCE_CLEAR",
      sessionId: params.sessionId,
      details: { studentId: params.studentId },
    },
    client
  );
  return { cleared: true };
}

/**
 * Finalize the register. THE SAFER POLICY (decision I), chosen after
 * discovery and encoded here:
 *
 *   * every expected student classified → finalize directly;
 *   * UNMARKED students remain → REFUSE unless the teacher explicitly
 *     acknowledges them (`acknowledgeUnmarked: true`), because silently
 *     converting them to ABSENT would punish a student for the teacher's
 *     omission, and silently finalizing around them hides the omission;
 *   * an acknowledged finalize NEVER writes ABSENT: the session keeps its
 *     unmarked students, is flagged ATTENDANCE_INCOMPLETE for admin review,
 *     and no absence case is created for them.
 *
 * Finalization is the ONLY input to the absence workflow (decision L).
 */
export async function finalizeAttendance(params: {
  sessionId: string;
  actorUserId: string;
  acknowledgeUnmarked?: boolean;
  now?: Date;
  client?: Client;
}): Promise<{
  session: any;
  counts: AttendanceCounts;
  finalizedAt: string;
  acknowledgedUnmarked: number;
  absenceCases: { created: number; existing: number };
}> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  const session = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!session) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  if (normalizeSessionStatus(session.status) === "CANCELLED") {
    throw new LiveSessionError("SESSION_CANCELLED", "A cancelled session has no attendance", 409);
  }
  if (session.attendanceFinalizedAt) {
    // Idempotent: finalizing twice returns the same state, never a second
    // absence fan-out (the cases themselves are also keyed 1:1).
    const { counts } = await loadSessionRoster(params.sessionId, { client, now });
    return {
      session,
      counts,
      finalizedAt: toIso(session.attendanceFinalizedAt)!,
      acknowledgedUnmarked: counts.unmarked,
      absenceCases: { created: 0, existing: 0 },
    };
  }

  const { rows, counts } = await loadSessionRoster(params.sessionId, { client, now });
  if (counts.unmarked > 0 && !params.acknowledgeUnmarked) {
    throw new LiveSessionError(
      "UNMARKED_REMAIN",
      "Some students are still unmarked",
      409,
      { unmarked: counts.unmarked, total: counts.total }
    );
  }

  const updated = (await (client as any).liveSession.update({
    where: { id: params.sessionId },
    data: {
      attendanceFinalizedAt: now,
      attendanceFinalizedByUserId: params.actorUserId,
      // A finalized register implies the class happened: if the teacher never
      // pressed start, finalization is itself the conducted marker.
      conductedAt: session.conductedAt ?? now,
      status:
        normalizeSessionStatus(session.status) === "SCHEDULED" ? "COMPLETED" : session.status,
      statusChangedAt: now,
      statusChangedByUserId: params.actorUserId,
    },
    select: SESSION_WITH_CONTEXT,
  })) as any;

  await auditLiveSession(
    {
      userId: params.actorUserId,
      action: "LIVE_SESSION_ATTENDANCE_FINALIZE",
      sessionId: updated.id,
      details: {
        total: counts.total,
        marked: counts.marked,
        unmarked: counts.unmarked,
        present: counts.present,
        late: counts.late,
        absent: counts.absent,
        excused: counts.excused,
        acknowledgedUnmarked: Boolean(params.acknowledgeUnmarked && counts.unmarked > 0),
      },
    },
    client
  );

  // The ONLY place absence cases are born (locked facts → review cases).
  const { materializeAbsenceCases } = await import("@/lib/absence-review");
  const cases = await materializeAbsenceCases({
    sessionId: updated.id,
    actorUserId: params.actorUserId,
    now,
    client,
  });

  return {
    session: updated,
    counts,
    finalizedAt: toIso(updated.attendanceFinalizedAt)!,
    acknowledgedUnmarked: params.acknowledgeUnmarked ? counts.unmarked : 0,
    absenceCases: cases,
  };
}

// ---------------------------------------------------------------------------
// Admin correction (the ONLY post-lock writer)
// ---------------------------------------------------------------------------

/**
 * Correct ONE attendance row after the lock. Requirements enforced here:
 * previous status, new status, a MANDATORY reason, the admin identity and the
 * timestamp — recorded in `AttendanceCorrection` AND in the platform
 * `AuditLog`. A teacher can never reach this function (its routes are
 * ADMIN-only).
 *
 * A correction to a non-ABSENT status voids the absence case (Phase F closes
 * it as NO_ACTION_REQUIRED and resolves any hold) — history is never silently
 * rewritten, and a case is never silently deleted.
 */
export async function correctAttendance(params: {
  sessionId: string;
  studentId: string;
  newStatus: unknown;
  reason: unknown;
  adminUserId: string;
  now?: Date;
  client?: Client;
}): Promise<{
  correction: any;
  previousStatus: AttendanceStatusValue;
  newStatus: AttendanceStatusValue;
  absenceCase: { voided: boolean; reviewId: string | null; holdResolved: boolean };
}> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();

  const reason = typeof params.reason === "string" ? params.reason.replace(/\s+/g, " ").trim() : "";
  if (reason.length < 3 || reason.length > 1000) {
    throw new LiveSessionError("CORRECTION_REASON_REQUIRED", "A correction reason is required", 400);
  }
  const nextStatus = normalizeAttendanceStatus(params.newStatus);
  if (!nextStatus) throw new LiveSessionError("INVALID_STATUS", "Unknown attendance status", 400);

  const attendance = (await (client as any).attendance.findFirst({
    where: { sessionId: params.sessionId, studentId: params.studentId },
    select: { id: true, status: true, sessionId: true, studentId: true },
  })) as
    | { id: string; status: AttendanceStatusValue; sessionId: string; studentId: string }
    | null;
  if (!attendance) {
    throw new LiveSessionError("ATTENDANCE_NOT_FOUND", "There is no attendance row to correct", 404);
  }
  const previousStatus = normalizeAttendanceStatus(attendance.status);
  if (!previousStatus) throw new LiveSessionError("INVALID_STATUS", "Unknown attendance status", 400);

  await (client as any).attendance.update({
    where: { id: attendance.id },
    data: { status: nextStatus, markedByUserId: params.adminUserId, markedAt: now },
  });

  const correction = (await (client as any).attendanceCorrection.create({
    data: {
      attendanceId: attendance.id,
      sessionId: params.sessionId,
      studentId: params.studentId,
      previousStatus,
      newStatus: nextStatus,
      reason,
      correctedByUserId: params.adminUserId,
      correctedAt: now,
    },
  })) as any;

  await auditLiveSession(
    {
      userId: params.adminUserId,
      action: "LIVE_SESSION_ATTENDANCE_CORRECTION",
      sessionId: params.sessionId,
      details: {
        studentId: params.studentId,
        attendanceId: attendance.id,
        previousStatus,
        newStatus: nextStatus,
        reason,
        correctionId: correction.id,
      },
    },
    client
  );

  // A corrected fact may invalidate the administrative case it produced.
  let absenceCase: { voided: boolean; reviewId: string | null; holdResolved: boolean } = {
    voided: false,
    reviewId: null,
    holdResolved: false,
  };
  if (previousStatus === "ABSENT" && nextStatus !== "ABSENT") {
    const { voidAbsenceCaseForCorrection } = await import("@/lib/absence-review");
    absenceCase = await voidAbsenceCaseForCorrection({
      sessionId: params.sessionId,
      studentId: params.studentId,
      adminUserId: params.adminUserId,
      now,
      client,
    });
  }

  return { correction, previousStatus, newStatus: nextStatus, absenceCase };
}

// ---------------------------------------------------------------------------
// Readers: upcoming, lists, detail, operations
// ---------------------------------------------------------------------------

/** Students of the group — the live audience behind the parent's card too. */
export async function upcomingForStudent(
  studentId: string,
  options: { limit?: number; now?: Date; client?: Client } = {}
): Promise<LiveSessionPayload[]> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const student = (await (client as any).student.findUnique({
    where: { id: studentId },
    select: { groupId: true },
  })) as { groupId: string | null } | null;
  if (!student?.groupId) return [];

  const sessions = (await (client as any).liveSession.findMany({
    where: {
      groupId: student.groupId,
      status: { in: ["SCHEDULED", "LIVE"] },
      startAt: { gte: new Date(now.getTime() - 6 * 60 * 60 * 1000) },
    },
    orderBy: { startAt: "asc" },
    take: options.limit ?? 20,
    select: SESSION_WITH_CONTEXT,
  })) as any[];

  return sessions.map((session) => toLiveSessionPayload({ session, now }));
}

/** A student's recent PAST sessions (history view: attended / missed). */
export async function recentSessionsForStudent(
  studentId: string,
  options: { limit?: number; now?: Date; client?: Client } = {}
): Promise<Array<LiveSessionPayload & { myStatus: RosterStatusValue }>> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const student = (await (client as any).student.findUnique({
    where: { id: studentId },
    select: { groupId: true },
  })) as { groupId: string | null } | null;
  if (!student?.groupId) return [];

  const sessions = (await (client as any).liveSession.findMany({
    where: { groupId: student.groupId, startAt: { lt: now } },
    orderBy: { startAt: "desc" },
    take: options.limit ?? 10,
    select: SESSION_WITH_CONTEXT,
  })) as any[];
  const rows = (await (client as any).attendance.findMany({
    where: { studentId, sessionId: { in: sessions.map((s) => s.id) } },
    select: { sessionId: true, status: true },
  })) as Array<{ sessionId: string; status: AttendanceStatusValue }>;
  const bySession = new Map(rows.map((r) => [r.sessionId, r.status]));
  return sessions.map((session) => ({
    ...toLiveSessionPayload({ session, now }),
    myStatus: bySession.has(session.id)
      ? (normalizeAttendanceStatus(bySession.get(session.id)) ?? "UNMARKED")
      : "UNMARKED",
  }));
}

/** Every session the teacher may work on: own groups + substitute sessions. */
export async function listSessionsForTeacher(
  scope: TeacherScope,
  options: {
    from?: Date;
    to?: Date;
    groupId?: string | null;
    limit?: number;
    now?: Date;
    client?: Client;
  } = {}
): Promise<Array<LiveSessionPayload & { counts: AttendanceCounts }>> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const groupFilter = options.groupId && scope.groupIds.includes(options.groupId) ? options.groupId : null;

  const where: Record<string, unknown> = {
    OR: [
      { groupId: groupFilter ?? { in: scope.groupIds } },
      { substituteTeacherId: scope.teacherId },
    ],
  };
  if (options.from || options.to) {
    where.startAt = {
      ...(options.from ? { gte: options.from } : {}),
      ...(options.to ? { lte: options.to } : {}),
    };
  }

  const sessions = (await (client as any).liveSession.findMany({
    where,
    orderBy: { startAt: "desc" },
    take: options.limit ?? 60,
    select: SESSION_WITH_CONTEXT,
  })) as any[];

  return withCounts(sessions, client, now);
}

/** Admin list with operational filters. */
export async function listSessionsForAdmin(options: {
  from?: Date;
  to?: Date;
  groupId?: string | null;
  teacherId?: string | null;
  status?: string | null;
  q?: string | null;
  limit?: number;
  now?: Date;
  client?: Client;
} = {}): Promise<Array<LiveSessionPayload & { counts: AttendanceCounts }>> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const where: Record<string, unknown> = {};
  if (options.groupId) where.groupId = options.groupId;
  if (options.teacherId) where.teacherId = options.teacherId;
  if (options.status) {
    const status = normalizeSessionStatus(options.status);
    if (!status) throw new LiveSessionError("INVALID_STATUS", "Unknown status filter", 400);
    where.status = status;
  }
  if (options.from || options.to) {
    where.startAt = {
      ...(options.from ? { gte: options.from } : {}),
      ...(options.to ? { lte: options.to } : {}),
    };
  }
  const q = options.q?.trim();
  if (q) where.OR = [{ title: { contains: q } }, { titleAr: { contains: q } }];

  const sessions = (await (client as any).liveSession.findMany({
    where,
    orderBy: { startAt: "desc" },
    take: options.limit ?? 100,
    select: SESSION_WITH_CONTEXT,
  })) as any[];
  return withCounts(sessions, client, now);
}

async function withCounts(
  sessions: any[],
  client: Client,
  now: Date
): Promise<Array<LiveSessionPayload & { counts: AttendanceCounts }>> {
  if (sessions.length === 0) return [];
  const sessionIds = sessions.map((s) => s.id);
  const groupIds = Array.from(new Set(sessions.map((s) => s.groupId)));
  const [attendanceRows, students] = await Promise.all([
    (client as any).attendance.findMany({
      where: { sessionId: { in: sessionIds } },
      select: { sessionId: true, studentId: true, status: true },
    }) as Promise<Array<{ sessionId: string; studentId: string; status: AttendanceStatusValue }>>,
    (client as any).student.findMany({
      where: { groupId: { in: groupIds }, user: { isActive: true } },
      select: { id: true, groupId: true },
    }) as Promise<Array<{ id: string; groupId: string | null }>>,
  ]);
  const rosterByGroup = new Map<string, string[]>();
  for (const s of students) {
    if (!s.groupId) continue;
    const list = rosterByGroup.get(s.groupId) ?? [];
    list.push(s.id);
    rosterByGroup.set(s.groupId, list);
  }
  const statusBySession = new Map<string, Map<string, AttendanceStatusValue>>();
  for (const row of attendanceRows) {
    const map = statusBySession.get(row.sessionId) ?? new Map();
    map.set(row.studentId, row.status);
    statusBySession.set(row.sessionId, map);
  }
  return sessions.map((session) => {
    const roster = rosterByGroup.get(session.groupId) ?? [];
    const marks = statusBySession.get(session.id) ?? new Map();
    const rows = roster.map((studentId) => ({ status: marks.get(studentId) ?? null }));
    const counts = countAttendanceRows(rows);
    return { ...toLiveSessionPayload({ session, now, counts }), counts };
  });
}

/** One session with its roster and counts (the workspace aggregate). */
export async function getSessionWorkspace(params: {
  sessionId: string;
  now?: Date;
  client?: Client;
}): Promise<{
  session: LiveSessionPayload;
  roster: RosterRow[];
  counts: AttendanceCounts;
  finalizeHint: { unmarked: number; total: number };
}> {
  const client = params.client ?? db;
  const now = params.now ?? new Date();
  const session = (await (client as any).liveSession.findUnique({
    where: { id: params.sessionId },
    select: SESSION_WITH_CONTEXT,
  })) as any;
  if (!session) throw new LiveSessionError("SESSION_NOT_FOUND", "Session not found", 404);
  const { rows, counts } = await loadSessionRoster(params.sessionId, { client, now });
  return {
    session: toLiveSessionPayload({ session, now, counts }),
    roster: rows,
    counts,
    finalizeHint: { unmarked: counts.unmarked, total: counts.total },
  };
}

export type AdminOpsOverview = {
  today: { total: number; live: number; upcoming: number };
  upcoming: number;
  notFinalized: number;
  attendanceIncomplete: number;
  teacherNoShow: number;
  absencesPending: number;
  cancelled: number;
  rescheduled: number;
  repeatedAbsenceFlags: Array<{
    studentId: string;
    studentName: string;
    count: number;
    threshold: number;
  }>;
};

/**
 * The ADMIN OPERATIONAL OVERVIEW. Counts are computed from the same payloads
 * the queues render, so a number can never disagree with the list beneath it.
 */
export async function buildAdminOpsOverview(options: {
  now?: Date;
  client?: Client;
} = {}): Promise<AdminOpsOverview> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
  const horizon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const sessions = (await (client as any).liveSession.findMany({
    where: { startAt: { gte: startOfDay, lte: horizon } },
    orderBy: { startAt: "asc" },
    take: 500,
    select: SESSION_WITH_CONTEXT,
  })) as any[];
  const decorated = await withCounts(sessions, client, now);

  let todayTotal = 0;
  let todayLive = 0;
  let upcoming = 0;
  let notFinalized = 0;
  let attendanceIncomplete = 0;
  let teacherNoShow = 0;
  let cancelled = 0;
  let rescheduled = 0;

  for (const item of decorated) {
    const startAt = new Date(item.startAt);
    if (startAt >= startOfDay && startAt < endOfDay) {
      todayTotal += 1;
      if (item.phase === "LIVE") todayLive += 1;
    }
    if (startAt >= now) upcoming += 1;
    if (item.status === "CANCELLED") cancelled += 1;
    if (item.rescheduleCount > 0) rescheduled += 1;
    if (
      !item.attendanceFinalizedAt &&
      item.reviewState !== "CANCELLED" &&
      item.reviewState !== "NOT_DUE" &&
      item.reviewState !== "ATTENDANCE_OPEN"
    ) {
      // "The register was never confirmed" — read from the timestamp, so an
      // ATTENDANCE_INCOMPLETE that IS finalized never inflates this counter.
      notFinalized += 1;
    }
    if (item.reviewState === "ATTENDANCE_INCOMPLETE") attendanceIncomplete += 1;
    if (item.reviewState === "TEACHER_NO_SHOW") teacherNoShow += 1;
  }

  const { countPendingAbsences, repeatedAbsenceFlags } = await import("@/lib/absence-review");
  const absencesPending = await countPendingAbsences({ client });
  const flags = await repeatedAbsenceFlags({ now, client });

  return {
    today: { total: todayTotal, live: todayLive, upcoming: Math.max(0, todayTotal - todayLive) },
    upcoming,
    notFinalized,
    attendanceIncomplete,
    teacherNoShow,
    absencesPending,
    cancelled,
    rescheduled,
    repeatedAbsenceFlags: flags,
  };
}

/** A review-queue listing of sessions the admin must look at. */
export async function listSessionsNeedingReview(options: {
  now?: Date;
  limit?: number;
  client?: Client;
} = {}): Promise<Array<LiveSessionPayload & { counts: AttendanceCounts }>> {
  const client = options.client ?? db;
  const now = options.now ?? new Date();
  const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sessions = (await (client as any).liveSession.findMany({
    where: { startAt: { gte: windowStart, lte: now }, status: { not: "CANCELLED" } },
    orderBy: { startAt: "desc" },
    take: options.limit ?? 100,
    select: SESSION_WITH_CONTEXT,
  })) as any[];
  const decorated = await withCounts(sessions, client, now);
  return decorated.filter(
    (s) => s.reviewState === "ATTENDANCE_INCOMPLETE" || s.reviewState === "TEACHER_NO_SHOW"
  );
}

export { ATTENDANCE_STATUSES };
