// CodeMind Academy — SessionVideo requirement applicability (pure rule + batched loaders).
//
// THE SINGLE AUTHORITY that decides, per (student × video), whether a
// requirement-mode recording actually gates THAT student. Consumed by the
// canonical progression loader, the student video list, and teacher readiness
// — every consumer reads THIS verdict, so the three surfaces can never
// disagree about who a recording is required for.
//
// Modes:
//   OPTIONAL        — content + telemetry only. Never a progression input,
//                     for anyone. (The default; every legacy row lands here
//                     unless its legacy flag mapped it to ALL_STUDENTS.)
//   ALL_STUDENTS    — required for every eligible student. Attendance is
//                     irrelevant: present, absent and excused students alike
//                     must satisfy watchPercent >= requiredPercent.
//   ABSENT_STUDENTS — required ONLY for students with a PROVEN unexcused
//                     absence for the video's explicitly-linked LiveSession.
//                     Everyone else is EXEMPT (present / excused / unmarked /
//                     undecided-register). An absence is PROVEN only when:
//                       1. an Attendance row EXISTS (UNMARKED ≠ ABSENT —
//                          Phase F; absence of a row never gates anyone),
//                       2. its status is exactly ABSENT (PRESENT / LATE /
//                          EXCUSED-fact all mean "attended or excused"),
//                       3. the session register is FINALIZED
//                          (attendanceFinalizedAt non-null — a draft mark is
//                          mutable and never feeds a downstream workflow),
//                       4. the AbsenceReview case (when one exists) is NOT
//                          EXCUSED (excused absences never convert into
//                          requirements) and NOT NO_ACTION_REQUIRED (the
//                          absence fact was invalidated by an attendance
//                          correction — there is no absence to cover).
//                     A PENDING (undecided) case keeps the requirement:
//                     the finalized absence stands until an admin excuses it,
//                     and the gate lifts automatically on EXCUSED. This is the
//                     incentive-compatible direction — fail-open on pending
//                     would let a student dodge catch-up by never submitting
//                     a reason — and it never invents an absence: the
//                     finalized ABSENT fact is already on record.
//
// Phase F is the attendance authority; this file only READS its facts
// (Attendance.status, LiveSession.attendanceFinalizedAt,
// AbsenceReview.status) through the rule above. Nothing here writes
// attendance, reviews, or holds.

/** The requirement-mode vocabulary (mirrors the Prisma enum). */
export const REQUIREMENT_MODES = [
  "OPTIONAL",
  "ALL_STUDENTS",
  "ABSENT_STUDENTS",
] as const;
export type RequirementMode = (typeof REQUIREMENT_MODES)[number];

export function normalizeRequirementMode(raw: unknown): RequirementMode | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return (REQUIREMENT_MODES as readonly string[]).includes(v)
    ? (v as RequirementMode)
    : null;
}

/**
 * Effective mode of a SessionVideo row. An explicit non-OPTIONAL mode wins
 * (every write path dual-writes the flag to match, so consistent rows always
 * resolve here). Otherwise the legacy boolean is HONORED, not ignored: a row
 * with `isRequiredForProgression = true` but no explicit mode (pre-backfill
 * rows, direct-seeded fixtures) maps to ALL_STUDENTS — the exact historical
 * meaning ("required for every eligible student") — never to OPTIONAL, so no
 * legacy requirement is silently dropped. Only a row with neither signal is
 * OPTIONAL. Fail-closed by construction: evidence of requiredness always
 * beats the default.
 */
export function effectiveRequirementMode(row: {
  requirementMode?: unknown;
  isRequiredForProgression?: unknown;
}): RequirementMode {
  const mode = normalizeRequirementMode(row?.requirementMode);
  if (mode !== null && mode !== "OPTIONAL") return mode;
  if (row?.isRequiredForProgression === true) return "ALL_STUDENTS";
  return "OPTIONAL";
}

/** A mode gates students (ALL_STUDENTS always; ABSENT_STUDENTS conditionally). */
export function modeRequires(mode: RequirementMode): boolean {
  return mode !== "OPTIONAL";
}

/** Phase F facts that feed the absence rule (all server-read, never trusted from the client). */
export type AbsenceFacts = {
  /** Attendance.status, or null when NO row exists (UNMARKED). */
  attendanceStatus: string | null;
  /** Whether the session register is finalized (attendanceFinalizedAt non-null). */
  finalized: boolean;
  /** AbsenceReview.status, or null when no case exists for the row. */
  reviewStatus: string | null;
};

/**
 * Machine-readable applicability verdict. REQUIRED_* gates the student;
 * EXEMPT_* never does. UI copy maps 1:1 (course.247–250).
 */
export type ApplicabilityReason =
  | "ALL_STUDENTS"
  | "OPTIONAL"
  | "NO_SESSION_LINK"
  | "REQUIRED_ABSENT"
  | "EXEMPT_PRESENT"
  | "EXEMPT_EXCUSED"
  | "EXEMPT_NO_ACTION"
  | "EXEMPT_UNMARKED"
  | "EXEMPT_NOT_FINALIZED";

export type ApplicabilityVerdict = {
  applicable: boolean;
  reason: ApplicabilityReason;
  /**
   * The Phase F facts behind an ABSENT_STUDENTS verdict (teacher readiness
   * renders them; gating consumers ignore them). Absent for OPTIONAL /
   * ALL_STUDENTS, which need no absence lookup.
   */
  detail?: {
    attendanceStatus: string | null;
    finalized: boolean;
    reviewStatus: string | null;
  };
};

/**
 * The pure absence rule. Same facts = same verdict, always. Absence must be
 * PROVEN (finalized ABSENT + not excused/invalidated) — every other shape,
 * including unknown/garbage statuses, is EXEMPT, because inventing an
 * absence is worse than missing one (the finalized register + review case
 * remain the teacher/admin path to correct the record).
 */
export function resolveAbsenceApplicability(facts: AbsenceFacts): ApplicabilityVerdict {
  const status = (facts?.attendanceStatus ?? "").trim().toUpperCase();
  if (!status) return { applicable: false, reason: "EXEMPT_UNMARKED" };
  if (status !== "ABSENT") return { applicable: false, reason: "EXEMPT_PRESENT" };
  if (!facts?.finalized) return { applicable: false, reason: "EXEMPT_NOT_FINALIZED" };
  const review = (facts?.reviewStatus ?? "").trim().toUpperCase();
  if (review === "EXCUSED") return { applicable: false, reason: "EXEMPT_EXCUSED" };
  if (review === "NO_ACTION_REQUIRED") return { applicable: false, reason: "EXEMPT_NO_ACTION" };
  // UNEXCUSED, PENDING_REASON, PENDING_REVIEW, missing case, or anything
  // else: the finalized absence stands, so the recording is required.
  return { applicable: true, reason: "REQUIRED_ABSENT" };
}

export type ApplicabilityVideoRef = {
  id: string;
  requirementMode?: unknown;
  isRequiredForProgression?: unknown;
  liveSessionId?: string | null;
};

/**
 * Minimal db surface the loaders need. Three batched queries, no N+1:
 * sessions, attendance rows, review cases — each a single `IN` query.
 *
 * The argument shapes are NARROW on purpose: each one mirrors exactly the
 * query the loader issues (a valid Prisma args subset — same where-keys,
 * same select-keys). A broad `(args: unknown)` parameter would be a REAL
 * typing bug: the generated delegates are generic and parameter-constrained
 * (`findMany<T extends LiveSessionFindManyArgs>(...)`), and under
 * contravariance a method that accepts only Prisma args is NOT assignable
 * to an interface claiming arbitrary `unknown` — the real PrismaClient was
 * rejected at every call site (the local typecheck failure). Narrow args keep
 * the real client (and transaction clients, whose delegates share the same
 * signatures) assignable with zero casts. Row shapes stay permissive
 * (`unknown` for enum/date payloads the rule only null-checks or stringifies).
 */
export type ApplicabilityDb = {
  liveSession: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; attendanceFinalizedAt: true };
    }): Promise<Array<{ id: string; attendanceFinalizedAt: unknown }>>;
  };
  attendance: {
    findMany(args: {
      where: { studentId: { in: string[] }; sessionId: { in: string[] } };
      select: { sessionId: true; studentId: true; status: true };
    }): Promise<Array<{ sessionId: string; studentId: string; status: unknown }>>;
  };
  absenceReview: {
    findMany(args: {
      where: { studentId: { in: string[] }; sessionId: { in: string[] } };
      select: { sessionId: true; studentId: true; status: true };
    }): Promise<Array<{ sessionId: string; studentId: string; status: unknown }>>;
  };
};

async function loadAbsenceFacts(
  db: ApplicabilityDb,
  studentIds: string[],
  sessionIds: string[]
): Promise<{
  finalizedBySession: Map<string, boolean>;
  attendanceByKey: Map<string, string | null>;
  reviewByKey: Map<string, string | null>;
}> {
  const finalizedBySession = new Map<string, boolean>();
  const attendanceByKey = new Map<string, string | null>();
  const reviewByKey = new Map<string, string | null>();
  if (studentIds.length === 0 || sessionIds.length === 0) return { finalizedBySession, attendanceByKey, reviewByKey };
  const [sessions, attendances, reviews] = await Promise.all([
    db.liveSession.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, attendanceFinalizedAt: true },
    }),
    db.attendance.findMany({
      where: { studentId: { in: studentIds }, sessionId: { in: sessionIds } },
      select: { sessionId: true, studentId: true, status: true },
    }),
    db.absenceReview.findMany({
      where: { studentId: { in: studentIds }, sessionId: { in: sessionIds } },
      select: { sessionId: true, studentId: true, status: true },
    }),
  ]);
  for (const s of sessions ?? []) finalizedBySession.set(s.id, s.attendanceFinalizedAt != null);
  for (const a of attendances ?? []) {
    attendanceByKey.set(`${a.studentId} ${a.sessionId}`, a.status == null ? null : String(a.status));
  }
  for (const r of reviews ?? []) {
    reviewByKey.set(`${r.studentId} ${r.sessionId}`, r.status == null ? null : String(r.status));
  }
  return { finalizedBySession, attendanceByKey, reviewByKey };
}

function verdictFor(
  video: ApplicabilityVideoRef,
  factsForSession: (sessionId: string) => AbsenceFacts | null
): ApplicabilityVerdict {
  const mode = effectiveRequirementMode(video);
  if (mode === "OPTIONAL") return { applicable: false, reason: "OPTIONAL" };
  if (mode === "ALL_STUDENTS") return { applicable: true, reason: "ALL_STUDENTS" };
  // ABSENT_STUDENTS — without an explicit session link there is no absence
  // to prove, so the video cannot gate anyone. Unreachable via the app
  // (every write path refuses linkless ABSENT_STUDENTS), but fail-open here
  // rather than trap students behind an unresolvable requirement — and say
  // so loudly with a dedicated reason (never a silent OPTIONAL).
  const sessionId = video?.liveSessionId ?? null;
  if (!sessionId) return { applicable: false, reason: "NO_SESSION_LINK" };
  const facts = factsForSession(sessionId);
  if (!facts) return { applicable: false, reason: "NO_SESSION_LINK" };
  return resolveAbsenceApplicability(facts);
}

/**
 * Per-video applicability for ONE student. Videos that need no absence
 * lookup (OPTIONAL / ALL_STUDENTS / linkless) resolve without any query;
 * ABSENT_STUDENTS videos share ONE batched triple-query.
 */
export async function loadVideoApplicability(
  db: ApplicabilityDb,
  studentId: string,
  videos: readonly ApplicabilityVideoRef[]
): Promise<Map<string, ApplicabilityVerdict>> {
  const out = new Map<string, ApplicabilityVerdict>();
  const absentSessionIds = [
    ...new Set(
      videos
        .filter((v) => effectiveRequirementMode(v) === "ABSENT_STUDENTS" && v.liveSessionId)
        .map((v) => v.liveSessionId as string)
    ),
  ];
  const { finalizedBySession, attendanceByKey, reviewByKey } = await loadAbsenceFacts(
    db,
    [studentId],
    absentSessionIds
  );
  const factsForSession = (sessionId: string): AbsenceFacts | null => {
    if (!finalizedBySession.has(sessionId)) return null;
    return {
      attendanceStatus: attendanceByKey.get(`${studentId} ${sessionId}`) ?? null,
      finalized: finalizedBySession.get(sessionId) ?? false,
      reviewStatus: reviewByKey.get(`${studentId} ${sessionId}`) ?? null,
    };
  };
  for (const v of videos) out.set(v.id, verdictFor(v, factsForSession));
  return out;
}

/**
 * Per-video applicability for MANY students (teacher readiness). Same three
 * batched queries with `studentId IN (...)` — never per-student round trips.
 */
export async function loadVideoApplicabilityMany(
  db: ApplicabilityDb,
  studentIds: readonly string[],
  videos: readonly ApplicabilityVideoRef[]
): Promise<Map<string, Map<string, ApplicabilityVerdict>>> {
  const ids = [...new Set(studentIds)];
  const absentSessionIds = [
    ...new Set(
      videos
        .filter((v) => effectiveRequirementMode(v) === "ABSENT_STUDENTS" && v.liveSessionId)
        .map((v) => v.liveSessionId as string)
    ),
  ];
  const { finalizedBySession, attendanceByKey, reviewByKey } = await loadAbsenceFacts(db, ids, absentSessionIds);
  const out = new Map<string, Map<string, ApplicabilityVerdict>>();
  for (const studentId of ids) {
    const perVideo = new Map<string, ApplicabilityVerdict>();
    const factsForSession = (sessionId: string): AbsenceFacts | null => {
      if (!finalizedBySession.has(sessionId)) return null;
      return {
        attendanceStatus: attendanceByKey.get(`${studentId} ${sessionId}`) ?? null,
        finalized: finalizedBySession.get(sessionId) ?? false,
        reviewStatus: reviewByKey.get(`${studentId} ${sessionId}`) ?? null,
      };
    };
    for (const v of videos) perVideo.set(v.id, verdictFor(v, factsForSession));
    out.set(studentId, perVideo);
  }
  return out;
}
