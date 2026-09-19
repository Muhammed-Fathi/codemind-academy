// CodeMind Academy — Phase F live-session POLICY (pure, no I/O).
//
// THE ONE PLACE that answers, for the live-teaching workflow:
//
//   * what is a valid Session Link?
//   * when does a session START / END / become joinable?
//   * when may a TEACHER edit attendance, and when is it LOCKED?
//   * which lifecycle flips are legal?
//   * what does "this session needs admin attention" mean?
//   * what is a session's MATERIAL REVISION (the notification idempotency
//     input, so a material change re-notifies and a retry does not)?
//
// WHY A SEPARATE PURE MODULE
// ==========================
// The windows below (join window, attendance window, lock instant) must be
// computed IDENTICALLY by the server gate and by every UI surface, and must
// never be re-derived per component (the roadmap explicitly forbids hardcoding
// the join window in several places). So they live here, once, as arithmetic
// over `(startAt, duration, now)` — no database, no Next, no React — and every
// caller (routes, services, UI, phase tests) imports THIS module. This file is
// therefore compiled standalone by the Phase F suite.
//
// TIME DISCIPLINE
// ===============
// All windows are computed from the SESSION ROW ONLY (`startAt` + `duration`),
// never from "when the row was created", "when the teacher clicked start", or
// `endedAt`. Ending a live period early is an operational fact; it must not
// silently move the attendance lock, because two readers (teacher UI and
// server gate) would then disagree about a session that is open for one and
// locked for the other.
//
// CONFIGURATION (one place, documented, testable)
// ===============================================
//   LIVE_SESSION_JOIN_EARLY_MINUTES       default 15   (clamp 0..240)
//   LIVE_SESSION_ATTENDANCE_GRACE_MINUTES default 15   (clamp 0..120)
//
// The attendance grace exists because discovery found the ONLY production
// behaviour so far was "editable forever": teachers in the existing workflow
// mark the register while the class is still wrapping up, minutes after the
// scheduled end. A bounded, centralized grace keeps that operational reality
// without reopening the unbounded window. Zero disables it.

// ---------------------------------------------------------------------------
// Windows & configuration
// ---------------------------------------------------------------------------

/** Join opens this many minutes BEFORE `startAt` (roadmap default: 15). */
export const LIVE_SESSION_JOIN_EARLY_MINUTES_DEFAULT = 15;
/** Attendance stays editable this many minutes AFTER the scheduled end. */
export const LIVE_SESSION_ATTENDANCE_GRACE_MINUTES_DEFAULT = 15;

export const LIVE_SESSION_JOIN_EARLY_MINUTES_MAX = 240;
export const LIVE_SESSION_ATTENDANCE_GRACE_MINUTES_MAX = 120;

function readClampedEnvMinutes(name: string, fallback: number, max: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export function liveSessionJoinEarlyMinutes(env?: Record<string, string | undefined>): number {
  if (env) {
    const raw = env.LIVE_SESSION_JOIN_EARLY_MINUTES;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return LIVE_SESSION_JOIN_EARLY_MINUTES_DEFAULT;
    }
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return LIVE_SESSION_JOIN_EARLY_MINUTES_DEFAULT;
    return Math.min(parsed, LIVE_SESSION_JOIN_EARLY_MINUTES_MAX);
  }
  return readClampedEnvMinutes(
    "LIVE_SESSION_JOIN_EARLY_MINUTES",
    LIVE_SESSION_JOIN_EARLY_MINUTES_DEFAULT,
    LIVE_SESSION_JOIN_EARLY_MINUTES_MAX
  );
}

export function liveSessionAttendanceGraceMinutes(
  env?: Record<string, string | undefined>
): number {
  if (env) {
    const raw = env.LIVE_SESSION_ATTENDANCE_GRACE_MINUTES;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return LIVE_SESSION_ATTENDANCE_GRACE_MINUTES_DEFAULT;
    }
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return LIVE_SESSION_ATTENDANCE_GRACE_MINUTES_DEFAULT;
    }
    return Math.min(parsed, LIVE_SESSION_ATTENDANCE_GRACE_MINUTES_MAX);
  }
  return readClampedEnvMinutes(
    "LIVE_SESSION_ATTENDANCE_GRACE_MINUTES",
    LIVE_SESSION_ATTENDANCE_GRACE_MINUTES_DEFAULT,
    LIVE_SESSION_ATTENDANCE_GRACE_MINUTES_MAX
  );
}

/** The minimal scheduling shape every window function needs. */
export type SchedulableSession = {
  startAt: Date | string;
  duration: number;
};

const MINUTE_MS = 60_000;

function toMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Effective duration in minutes.
 *
 * A missing / non-finite / ≤0 duration falls back to the model's own default
 * (`LiveSession.duration @default(120)`). It deliberately does NOT collapse to
 * 0: a zero-length session would end the instant it started, which would make
 * its attendance window un-openable and its review state permanently
 * "no-show" — the exact opposite of the lenient behaviour a malformed row
 * deserves.
 */
export const LIVE_SESSION_DEFAULT_DURATION_MINUTES = 120;

export function sessionDurationMinutes(session: { duration?: number | null }): number {
  const raw = Number(session?.duration ?? LIVE_SESSION_DEFAULT_DURATION_MINUTES);
  if (!Number.isFinite(raw) || raw <= 0) return LIVE_SESSION_DEFAULT_DURATION_MINUTES;
  return Math.floor(raw);
}

/** `endsAt = startAt + duration` — the ONE derivation of a session's end. */
export function sessionEndsAt(session: SchedulableSession): Date {
  return new Date(toMs(session.startAt) + sessionDurationMinutes(session) * MINUTE_MS);
}

export type LiveSessionWindows = {
  startAt: Date;
  endsAt: Date;
  /** Join becomes actionable here (startAt − earlyMinutes). */
  joinOpensAt: Date;
  /** Join action stops being offered here (the scheduled end). */
  joinClosesAt: Date;
  /** Attendance may be written from here (the scheduled start). */
  attendanceOpensAt: Date;
  /** Attendance is LOCKED after here (scheduled end + grace). */
  attendanceClosesAt: Date;
  joinEarlyMinutes: number;
  attendanceGraceMinutes: number;
};

export function liveSessionWindows(
  session: SchedulableSession,
  env?: Record<string, string | undefined>
): LiveSessionWindows {
  const joinEarlyMinutes = liveSessionJoinEarlyMinutes(env);
  const attendanceGraceMinutes = liveSessionAttendanceGraceMinutes(env);
  const startAt = new Date(toMs(session.startAt));
  const endsAt = sessionEndsAt(session);
  return {
    startAt,
    endsAt,
    joinOpensAt: new Date(startAt.getTime() - joinEarlyMinutes * MINUTE_MS),
    joinClosesAt: endsAt,
    // Attendance opens at the scheduled start: before that the register is
    // READ-ONLY (a teacher cannot pre-mark a class that has not happened).
    attendanceOpensAt: startAt,
    attendanceClosesAt: new Date(endsAt.getTime() + attendanceGraceMinutes * MINUTE_MS),
    joinEarlyMinutes,
    attendanceGraceMinutes,
  };
}

// ---------------------------------------------------------------------------
// Session Link validation (the ONLY entry point for a meeting URL)
// ---------------------------------------------------------------------------

export type MeetingProvider = "GOOGLE_MEET" | "ZOOM" | "MICROSOFT_TEAMS" | "OTHER";

export type MeetingUrlRejectionCode =
  | "URL_REQUIRED"
  | "NOT_A_URL"
  | "UNSAFE_SCHEME"
  | "INSECURE_SCHEME"
  | "CREDENTIALS_IN_URL"
  | "MISSING_HOST"
  | "TOO_LONG";

export type MeetingUrlResult =
  | { ok: true; url: string; provider: MeetingProvider; host: string }
  | { ok: false; code: MeetingUrlRejectionCode };

/** Hard bound: the column is a free string, so the edge must bound it. */
export const MEETING_URL_MAX_LENGTH = 1024;

const PROVIDER_HOSTS: Array<{ provider: MeetingProvider; suffixes: readonly string[] }> = [
  { provider: "GOOGLE_MEET", suffixes: ["meet.google.com"] },
  { provider: "ZOOM", suffixes: ["zoom.us", "zoom.com", "zoomgov.com"] },
  {
    provider: "MICROSOFT_TEAMS",
    suffixes: ["teams.microsoft.com", "teams.live.com", "teams.microsoft.us"],
  },
];

export function detectMeetingProvider(host: string): MeetingProvider {
  const normalized = host.toLowerCase();
  for (const entry of PROVIDER_HOSTS) {
    for (const suffix of entry.suffixes) {
      if (normalized === suffix || normalized.endsWith(`.${suffix}`)) return entry.provider;
    }
  }
  return "OTHER";
}

/**
 * Validate a Session Link. The contract:
 *
 *   * REQUIRED to be an absolute `https:` URL — `http:`, `javascript:`,
 *     `data:`, `file:`, `blob:`, protocol-relative strings and bare hosts are
 *     all rejected. The UI never renders, and the API never stores, a link
 *     whose scheme could execute or leak.
 *   * CREDENTIALS ARE REJECTED (`https://user:pass@host/…`): a meeting URL
 *     with embedded credentials would be handed to every student in the group.
 *   * The host must be a real DNS-shaped host (contains a dot, only
 *     `[a-z0-9.-]`), so `https://localhost` / `https://intranet/` (no dot) are
 *     rejected while IP-literal https URLs remain allowed.
 *   * Total length ≤ 1024.
 *
 * Provider detection is informational (label + icon); it NEVER restricts the
 * host — "equivalent valid HTTPS provider" is explicitly allowed.
 */
export function validateMeetingUrl(raw: unknown): MeetingUrlResult {
  if (raw === null || raw === undefined) return { ok: false, code: "URL_REQUIRED" };
  if (typeof raw !== "string") return { ok: false, code: "NOT_A_URL" };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, code: "URL_REQUIRED" };
  if (trimmed.length > MEETING_URL_MAX_LENGTH) return { ok: false, code: "TOO_LONG" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, code: "NOT_A_URL" };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:") {
    // Distinguish "an unsafe scheme" (javascript:, data:, file:, blob:) from
    // "the right scheme at the wrong security level" (http:) so the operator
    // gets an actionable message — both are refused.
    if (protocol === "http:") return { ok: false, code: "INSECURE_SCHEME" };
    return { ok: false, code: "UNSAFE_SCHEME" };
  }
  if (parsed.username || parsed.password) return { ok: false, code: "CREDENTIALS_IN_URL" };

  const host = parsed.hostname.toLowerCase();
  if (!host || !host.includes(".") || !/^[a-z0-9.-]+$/.test(host)) {
    return { ok: false, code: "MISSING_HOST" };
  }

  // Normalize: drop the fragment (never meaningful for a meeting) and keep
  // path + query EXACTLY as supplied (Zoom/Teams carry tokens there).
  parsed.hash = "";
  return {
    ok: true,
    url: parsed.toString(),
    provider: detectMeetingProvider(host),
    host,
  };
}

/** True exactly when `validateMeetingUrl` accepts the value. */
export function isSafeMeetingUrl(raw: unknown): boolean {
  return validateMeetingUrl(raw).ok;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const SESSION_STATUSES = ["SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"] as const;
export type SessionStatusValue = (typeof SESSION_STATUSES)[number];

export function normalizeSessionStatus(raw: unknown): SessionStatusValue | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return (SESSION_STATUSES as readonly string[]).includes(v) ? (v as SessionStatusValue) : null;
}

/**
 * The ONE lifecycle lattice. `RESCHEDULED` is deliberately not a state: it is
 * an EVENT on a session that is (and stays) SCHEDULED. See the schema comment
 * on `LiveSession` for why.
 */
export const SESSION_TRANSITIONS: Record<SessionStatusValue, readonly SessionStatusValue[]> = {
  SCHEDULED: ["LIVE", "COMPLETED", "CANCELLED"],
  LIVE: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionSession(
  from: unknown,
  to: unknown
): boolean {
  const f = normalizeSessionStatus(from);
  const t = normalizeSessionStatus(to);
  if (!f || !t) return false;
  return SESSION_TRANSITIONS[f].includes(t);
}

/** A session is TERMINAL when no further lifecycle flip is legal. */
export function isTerminalSessionStatus(status: unknown): boolean {
  const s = normalizeSessionStatus(status);
  return s === "COMPLETED" || s === "CANCELLED";
}

export type LiveSessionPhase = "UPCOMING" | "LIVE" | "ENDED" | "CANCELLED";

/** The phase a viewer sees, derived from schedule + status + clock. */
export function deriveSessionPhase(session: SchedulableSession & { status?: unknown }, now: Date): LiveSessionPhase {
  const status = normalizeSessionStatus(session.status);
  if (status === "CANCELLED") return "CANCELLED";
  const windows = liveSessionWindows(session);
  const t = now.getTime();
  if (t < windows.startAt.getTime()) return "UPCOMING";
  if (status === "COMPLETED") return "ENDED";
  if (t < windows.endsAt.getTime()) return "LIVE";
  return "ENDED";
}

// ---------------------------------------------------------------------------
// Join window
// ---------------------------------------------------------------------------

export type JoinDenialCode =
  | "SESSION_CANCELLED"
  | "LINK_NOT_SET"
  | "TOO_EARLY"
  | "SESSION_ENDED";

export type JoinDecision =
  | { allowed: true; url: string | null; opensAt: Date; closesAt: Date }
  | { allowed: false; code: JoinDenialCode; opensAt: Date; closesAt: Date; opensInMinutes: number };

/**
 * May this viewer be handed the meeting link RIGHT NOW?
 *
 * `meetingUrl` is passed through the validator first: an unsafe stored value
 * (a legacy `javascript:` row, a corrupted link) is treated as "no link", so
 * the join endpoint can never hand out something the UI must not open.
 */
export function decideJoin(
  session: SchedulableSession & { status?: unknown; meetingUrl?: string | null },
  now: Date
): JoinDecision {
  const windows = liveSessionWindows(session);
  const status = normalizeSessionStatus(session.status);
  if (status === "CANCELLED") {
    return { allowed: false, code: "SESSION_CANCELLED", opensAt: windows.joinOpensAt, closesAt: windows.joinClosesAt, opensInMinutes: 0 };
  }
  const link = validateMeetingUrl(session.meetingUrl);
  if (!link.ok) {
    return { allowed: false, code: "LINK_NOT_SET", opensAt: windows.joinOpensAt, closesAt: windows.joinClosesAt, opensInMinutes: 0 };
  }
  const t = now.getTime();
  if (t < windows.joinOpensAt.getTime()) {
    const opensInMinutes = Math.max(
      1,
      Math.ceil((windows.joinOpensAt.getTime() - t) / MINUTE_MS)
    );
    return { allowed: false, code: "TOO_EARLY", opensAt: windows.joinOpensAt, closesAt: windows.joinClosesAt, opensInMinutes };
  }
  if (t >= windows.joinClosesAt.getTime()) {
    return { allowed: false, code: "SESSION_ENDED", opensAt: windows.joinOpensAt, closesAt: windows.joinClosesAt, opensInMinutes: 0 };
  }
  return { allowed: true, url: link.url, opensAt: windows.joinOpensAt, closesAt: windows.joinClosesAt };
}

// ---------------------------------------------------------------------------
// Attendance window & lock
// ---------------------------------------------------------------------------

export type AttendanceWriteDenialCode =
  | "NOT_STARTED"
  | "WINDOW_CLOSED"
  | "ALREADY_FINALIZED"
  | "SESSION_CANCELLED";

export type AttendanceWriteDecision =
  | { allowed: true; closesAt: Date }
  | { allowed: false; code: AttendanceWriteDenialCode; closesAt: Date };

/**
 * May a TEACHER write attendance for this session right now?
 *
 *   * CANCELLED               → refused (a cancelled class never produces
 *                               attendance facts, let alone absences);
 *   * already finalized       → refused (only an ADMIN correction may then
 *                               change a row);
 *   * before `startAt`        → refused (read-only register);
 *   * inside the window       → allowed;
 *   * after end + grace       → refused (`WINDOW_CLOSED`, the Phase F lock).
 */
export function decideAttendanceWrite(
  session: SchedulableSession & {
    status?: unknown;
    attendanceFinalizedAt?: Date | string | null;
  },
  now: Date
): AttendanceWriteDecision {
  const windows = liveSessionWindows(session);
  const closesAt = windows.attendanceClosesAt;
  if (normalizeSessionStatus(session.status) === "CANCELLED") {
    return { allowed: false, code: "SESSION_CANCELLED", closesAt };
  }
  if (session.attendanceFinalizedAt) {
    return { allowed: false, code: "ALREADY_FINALIZED", closesAt };
  }
  const t = now.getTime();
  if (t < windows.attendanceOpensAt.getTime()) return { allowed: false, code: "NOT_STARTED", closesAt };
  if (t >= closesAt.getTime()) return { allowed: false, code: "WINDOW_CLOSED", closesAt };
  return { allowed: true, closesAt };
}

export function isAttendanceLocked(
  session: SchedulableSession & {
    status?: unknown;
    attendanceFinalizedAt?: Date | string | null;
  },
  now: Date
): boolean {
  return decideAttendanceWrite(session, now).allowed === false;
}

// ---------------------------------------------------------------------------
// Attendance facts (UNMARKED ≠ ABSENT)
// ---------------------------------------------------------------------------

/** The FACT vocabulary stored on `Attendance.status`. */
export const ATTENDANCE_STATUSES = ["PRESENT", "LATE", "ABSENT", "EXCUSED"] as const;
export type AttendanceStatusValue = (typeof ATTENDANCE_STATUSES)[number];

export function normalizeAttendanceStatus(raw: unknown): AttendanceStatusValue | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return (ATTENDANCE_STATUSES as readonly string[]).includes(v)
    ? (v as AttendanceStatusValue)
    : null;
}

/** The ROSTER vocabulary: a student with no row is UNMARKED (never ABSENT). */
export const ROSTER_STATUSES = ["UNMARKED", "PRESENT", "LATE", "ABSENT", "EXCUSED"] as const;
export type RosterStatusValue = (typeof ROSTER_STATUSES)[number];

export function rosterStatusOf(row: { status?: unknown } | null | undefined): RosterStatusValue {
  if (!row) return "UNMARKED";
  return normalizeAttendanceStatus(row.status) ?? "UNMARKED";
}

export type AttendanceCounts = {
  total: number;
  marked: number;
  unmarked: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  /** Attended = PRESENT + LATE (the platform's existing convention). */
  attended: number;
};

/** Count a roster. `rows` is one entry per EXPECTED student. */
export function countAttendanceRows(rows: Array<{ status?: unknown }>): AttendanceCounts {
  const counts: AttendanceCounts = {
    total: rows.length,
    marked: 0,
    unmarked: 0,
    present: 0,
    late: 0,
    absent: 0,
    excused: 0,
    attended: 0,
  };
  for (const row of rows) {
    switch (rosterStatusOf(row)) {
      case "UNMARKED":
        counts.unmarked += 1;
        break;
      case "PRESENT":
        counts.present += 1;
        counts.marked += 1;
        counts.attended += 1;
        break;
      case "LATE":
        counts.late += 1;
        counts.marked += 1;
        counts.attended += 1;
        break;
      case "ABSENT":
        counts.absent += 1;
        counts.marked += 1;
        break;
      case "EXCUSED":
        counts.excused += 1;
        counts.marked += 1;
        break;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Operational review states (no-show / incomplete / finalized)
// ---------------------------------------------------------------------------

export type SessionReviewState =
  | "NOT_DUE"
  | "ATTENDANCE_OPEN"
  | "AWAITING_TEACHER"
  | "ATTENDANCE_INCOMPLETE"
  | "TEACHER_NO_SHOW"
  | "FINALIZED"
  | "CANCELLED";

/**
 * The OPERATIONAL state of a session's register, used by the admin queues.
 *
 * The states are DERIVED, never stored, so they cannot go stale:
 *
 *   NOT_DUE                before the register opens
 *   ATTENDANCE_OPEN        the register is open and the session is running
 *   AWAITING_TEACHER       the class is over but the register window is still
 *                          open — the teacher can still finish it themselves
 *   ATTENDANCE_INCOMPLETE  either (a) the register IS finalized but students
 *                          are left UNMARKED (the admin-review signal for a
 *                          forgotten student), or (b) the window closed with
 *                          the teacher active (started / partially marked) and
 *                          the register still unfinalized
 *   TEACHER_NO_SHOW        the window closed and NOTHING happened: no start, no
 *                          attendance, no finalization. Phase F NEVER converts
 *                          this into student absences; it is a signal about the
 *                          TEACHER's activity, not the students'
 *   FINALIZED              finalized with every expected student classified
 *   CANCELLED              never due for review, never generates absences
 */
export function deriveSessionReviewState(
  session: SchedulableSession & {
    status?: unknown;
    conductedAt?: Date | string | null;
    attendanceFinalizedAt?: Date | string | null;
  },
  counts: { marked: number; unmarked?: number },
  now: Date
): SessionReviewState {
  if (normalizeSessionStatus(session.status) === "CANCELLED") return "CANCELLED";
  const windows = liveSessionWindows(session);
  const t = now.getTime();

  if (session.attendanceFinalizedAt) {
    // A finalized register with UNMARKED students is the one case the admin
    // must look at: nobody was punished, but somebody was forgotten.
    return (counts.unmarked ?? 0) > 0 ? "ATTENDANCE_INCOMPLETE" : "FINALIZED";
  }
  if (t < windows.attendanceOpensAt.getTime()) return "NOT_DUE";
  if (t < windows.endsAt.getTime()) return "ATTENDANCE_OPEN";
  // The class is over. While the register window is still open the ball is in
  // the TEACHER's court; after it closes the session becomes administrative.
  if (t <= windows.attendanceClosesAt.getTime()) return "AWAITING_TEACHER";
  if (session.conductedAt || counts.marked > 0) return "ATTENDANCE_INCOMPLETE";
  return "TEACHER_NO_SHOW";
}

// ---------------------------------------------------------------------------
// Material revision & notification idempotency
// ---------------------------------------------------------------------------

/**
 * The MATERIAL REVISION of a session: a short digest of everything whose
 * change is worth telling students about (schedule, link, teacher, status).
 *
 * It is the input to every Phase F notification dedupe key, which is what
 * makes retries idempotent WITHOUT freezing out real updates: rescheduling a
 * session changes the revision and therefore legitimately emits a new
 * notification, while re-submitting the same form (or re-running a failed
 * request) computes the same key and inserts nothing.
 */
export function sessionRevision(session: {
  startAt: Date | string;
  duration: number;
  meetingUrl?: string | null;
  status?: unknown;
  teacherId?: string | null;
  substituteTeacherId?: string | null;
}): string {
  const rawStart = session.startAt instanceof Date ? session.startAt.toISOString() : String(session.startAt);
  const link = validateMeetingUrl(session.meetingUrl);
  const linkKey = link.ok ? link.url : "";
  return [
    rawStart,
    String(sessionDurationMinutes(session)),
    linkKey,
    String(normalizeSessionStatus(session.status) ?? ""),
    session.substituteTeacherId || session.teacherId || "",
  ].join("|");
}

export type SessionEventKind =
  | "SESSION_SCHEDULED"
  | "SESSION_LINK"
  | "SESSION_RESCHEDULED"
  | "SESSION_CANCELLED";

/** Deterministic idempotency key for one recipient's copy of one event. */
export function sessionEventDedupeKey(
  kind: SessionEventKind,
  sessionId: string,
  revision: string
): string {
  return `${kind}:${sessionId}:${revision}`;
}

// ---------------------------------------------------------------------------
// Repeated-absence signal (informational, never punitive)
// ---------------------------------------------------------------------------

/** ≥ this many finalized ABSENT sessions in the window raises the flag. */
export const REPEATED_ABSENCE_THRESHOLD_DEFAULT = 3;
export const REPEATED_ABSENCE_WINDOW_DAYS_DEFAULT = 30;

export function repeatedAbsenceThreshold(env?: Record<string, string | undefined>): number {
  const raw = env?.REPEATED_ABSENCE_THRESHOLD ?? (typeof process !== "undefined" ? process.env?.REPEATED_ABSENCE_THRESHOLD : undefined);
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 2) return REPEATED_ABSENCE_THRESHOLD_DEFAULT;
  return Math.min(parsed, 20);
}

export function repeatedAbsenceWindowDays(env?: Record<string, string | undefined>): number {
  const raw = env?.REPEATED_ABSENCE_WINDOW_DAYS ?? (typeof process !== "undefined" ? process.env?.REPEATED_ABSENCE_WINDOW_DAYS : undefined);
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return REPEATED_ABSENCE_WINDOW_DAYS_DEFAULT;
  return Math.min(parsed, 365);
}

/**
 * The flag is FACTUAL: it reports how many finalized absences occurred in the
 * window and whether that reaches the threshold. It carries no consequence —
 * Phase F never bans, suspends, unenrolls or labels a student.
 */
export function evaluateRepeatedAbsence(
  finalizedAbsenceCount: number,
  threshold: number = REPEATED_ABSENCE_THRESHOLD_DEFAULT
): { flagged: boolean; count: number; threshold: number } {
  const count = Number.isFinite(finalizedAbsenceCount) ? Math.max(0, Math.floor(finalizedAbsenceCount)) : 0;
  return { flagged: count >= threshold, count, threshold };
}

// ---------------------------------------------------------------------------
// i18n label keys (UI never prints a raw enum)
// ---------------------------------------------------------------------------

export function sessionStatusLabelKey(status: unknown): string {
  switch (normalizeSessionStatus(status)) {
    case "SCHEDULED":
      return "live.status.scheduled";
    case "LIVE":
      return "live.status.live";
    case "COMPLETED":
      return "live.status.ended";
    case "CANCELLED":
      return "live.status.cancelled";
    default:
      return "live.status.unknown";
  }
}

export function attendanceStatusLabelKey(status: unknown): string {
  switch (rosterStatusOf(status === null || status === undefined ? null : { status })) {
    case "PRESENT":
      return "live.attendance.present";
    case "LATE":
      return "live.attendance.late";
    case "ABSENT":
      return "live.attendance.absent";
    case "EXCUSED":
      return "live.attendance.excused";
    default:
      return "live.attendance.unmarked";
  }
}

export function sessionReviewStateLabelKey(state: SessionReviewState): string {
  switch (state) {
    case "NOT_DUE":
      return "live.review.notDue";
    case "ATTENDANCE_OPEN":
      return "live.review.open";
    case "AWAITING_TEACHER":
      return "live.review.awaitingTeacher";
    case "ATTENDANCE_INCOMPLETE":
      return "live.review.incomplete";
    case "TEACHER_NO_SHOW":
      return "live.review.noShow";
    case "FINALIZED":
      return "live.review.finalized";
    case "CANCELLED":
      return "live.status.cancelled";
  }
}

export function meetingProviderLabelKey(provider: MeetingProvider): string {
  switch (provider) {
    case "GOOGLE_MEET":
      return "live.provider.meet";
    case "ZOOM":
      return "live.provider.zoom";
    case "MICROSOFT_TEAMS":
      return "live.provider.teams";
    default:
      return "live.provider.other";
  }
}
