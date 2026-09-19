// CodeMind Academy — Phase F absence-REVIEW policy (pure, no I/O).
//
// THE SEPARATION THIS FILE ENFORCES
// =================================
//   ATTENDANCE FACT        `Attendance.status = ABSENT` (locked, immutable)
//   ADMINISTRATIVE VIEW    `AbsenceReview.status` — this state machine
//
// The roadmap's requirement is explicit: do NOT overload the attendance status
// with the review state, and do NOT trigger the absence workflow from a
// temporary ABSENT click. Everything that decides *when a case exists*, *who
// may move it*, and *what it produces* is a pure function here, so the API
// routes, the admin queue and the Phase F suite all agree.
//
//   (finalized ABSENT)  ──► PENDING_REASON ──► PENDING_REVIEW ──┐
//                                │  ▲                            ├─► EXCUSED   (no hold / resolved)
//                                │  └── new reason submission ───┤
//                                │                               └─► UNEXCUSED (ACTIVE hold)
//                                └──────────────► NO_ACTION_REQUIRED
//                                    (attendance row corrected by an admin:
//                                     the case is closed WITHOUT a decision,
//                                     never silently relabelled)
//
// EXCUSED ≠ ACADEMIC COMPLETION (mandatory distinction, decision Q):
// an excused absence resolves the ADMINISTRATIVE review only. Phase F does not
// unlock the next academic Lesson, and Phase H is where the missed session's
// requirements are enforced before progression. `holdResolutionFor()` encodes
// exactly that: UNEXCUSED → ACTIVE hold, EXCUSED → RESOLVED hold.

/** The administrative vocabulary stored on `AbsenceReview.status`. */
export const ABSENCE_REVIEW_STATUSES = [
  "PENDING_REASON",
  "PENDING_REVIEW",
  "EXCUSED",
  "UNEXCUSED",
  "NO_ACTION_REQUIRED",
] as const;
export type AbsenceReviewStatusValue = (typeof ABSENCE_REVIEW_STATUSES)[number];

export function normalizeAbsenceReviewStatus(raw: unknown): AbsenceReviewStatusValue | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return (ABSENCE_REVIEW_STATUSES as readonly string[]).includes(v)
    ? (v as AbsenceReviewStatusValue)
    : null;
}

/** The two decisions an admin may take. */
export const ABSENCE_DECISIONS = ["EXCUSE", "UNEXCUSE"] as const;
export type AbsenceDecision = (typeof ABSENCE_DECISIONS)[number];

export function normalizeAbsenceDecision(raw: unknown): AbsenceDecision | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return (ABSENCE_DECISIONS as readonly string[]).includes(v) ? (v as AbsenceDecision) : null;
}

/** Who may submit a reason (the platform `Role` vocabulary). */
export const ABSENCE_SUBMITTER_ROLES = ["STUDENT", "PARENT", "ADMIN"] as const;
export type AbsenceSubmitterRole = (typeof ABSENCE_SUBMITTER_ROLES)[number];

export function normalizeAbsenceSubmitterRole(raw: unknown): AbsenceSubmitterRole | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return (ABSENCE_SUBMITTER_ROLES as readonly string[]).includes(v)
    ? (v as AbsenceSubmitterRole)
    : null;
}

/** Reason text bounds. A plain reason is enough in Phase F (no uploads). */
export const ABSENCE_REASON_MIN_LENGTH = 3;
export const ABSENCE_REASON_MAX_LENGTH = 1000;
export const ABSENCE_DECISION_NOTE_MAX_LENGTH = 1000;

export type ReasonValidation =
  | { ok: true; reason: string }
  | { ok: false; code: "REASON_REQUIRED" | "REASON_TOO_SHORT" | "REASON_TOO_LONG" };

export function validateAbsenceReason(raw: unknown): ReasonValidation {
  if (typeof raw !== "string") return { ok: false, code: "REASON_REQUIRED" };
  const reason = raw.replace(/\s+/g, " ").trim();
  if (reason.length === 0) return { ok: false, code: "REASON_REQUIRED" };
  if (reason.length < ABSENCE_REASON_MIN_LENGTH) return { ok: false, code: "REASON_TOO_SHORT" };
  if (reason.length > ABSENCE_REASON_MAX_LENGTH) return { ok: false, code: "REASON_TOO_LONG" };
  return { ok: true, reason };
}

export type DecisionNoteValidation =
  | { ok: true; note: string | null }
  | { ok: false; code: "NOTE_TOO_LONG" };

export function validateDecisionNote(raw: unknown): DecisionNoteValidation {
  if (raw === null || raw === undefined) return { ok: true, note: null };
  if (typeof raw !== "string") return { ok: true, note: null };
  const note = raw.replace(/\s+/g, " ").trim();
  if (note.length === 0) return { ok: true, note: null };
  if (note.length > ABSENCE_DECISION_NOTE_MAX_LENGTH) return { ok: false, code: "NOTE_TOO_LONG" };
  return { ok: true, note };
}

/** A case may receive a reason while it has not been decided yet. */
export function canSubmitReason(status: unknown): boolean {
  const s = normalizeAbsenceReviewStatus(status);
  return s === "PENDING_REASON" || s === "PENDING_REVIEW";
}

export function isAbsenceDecided(status: unknown): boolean {
  const s = normalizeAbsenceReviewStatus(status);
  return s === "EXCUSED" || s === "UNEXCUSED" || s === "NO_ACTION_REQUIRED";
}

/** A case may be decided only once, and only before a decision exists. */
export function canDecide(status: unknown): boolean {
  const s = normalizeAbsenceReviewStatus(status);
  return s === "PENDING_REASON" || s === "PENDING_REVIEW";
}

/** The status a case moves to after a (new) reason submission. */
export function statusAfterReasonSubmission(current: unknown): AbsenceReviewStatusValue {
  const s = normalizeAbsenceReviewStatus(current);
  // A decided case is closed: a late reason is still stored (history is never
  // destroyed) but it does NOT reopen the decision.
  if (s === "EXCUSED" || s === "UNEXCUSED" || s === "NO_ACTION_REQUIRED") return s;
  return "PENDING_REVIEW";
}

/** The status a decision produces. */
export function statusForDecision(decision: AbsenceDecision): AbsenceReviewStatusValue {
  return decision === "EXCUSE" ? "EXCUSED" : "UNEXCUSED";
}

export type AbsenceHoldState = "ACTIVE" | "RESOLVED";

/**
 * The hold a DECIDED case produces:
 *
 *   UNEXCUSED → ACTIVE   (Phase H blocks next Lesson / next session link /
 *                         recordings until the absence is resolved)
 *   EXCUSED   → RESOLVED (the administrative review is closed; Phase H still
 *                         routes the student through the missed session's own
 *                         academic requirements — approval is not completion)
 */
export function holdStatusForDecision(decision: AbsenceDecision): AbsenceHoldState {
  return decision === "EXCUSE" ? "RESOLVED" : "ACTIVE";
}

/**
 * When an admin CORRECTS the underlying attendance row (e.g. ABSENT → LATE),
 * the absence fact disappears. The case must then be closed as
 * NO_ACTION_REQUIRED — never silently deleted, never relabelled EXCUSED — and
 * any hold it produced is resolved.
 */
export function isCaseVoidedByAttendanceCorrection(nextStatus: unknown): boolean {
  return String(nextStatus ?? "").trim().toUpperCase() !== "ABSENT";
}

/** The admin queue filter vocabulary (nothing else is accepted). */
export const ABSENCE_QUEUE_FILTERS = [
  "ALL",
  "PENDING_REASON",
  "PENDING_REVIEW",
  "EXCUSED",
  "UNEXCUSED",
  "NO_ACTION_REQUIRED",
] as const;
export type AbsenceQueueFilter = (typeof ABSENCE_QUEUE_FILTERS)[number];

export function normalizeAbsenceQueueFilter(raw: unknown): AbsenceQueueFilter | null {
  if (raw === null || raw === undefined || raw === "") return "ALL";
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  return (ABSENCE_QUEUE_FILTERS as readonly string[]).includes(v)
    ? (v as AbsenceQueueFilter)
    : null;
}

export function absenceReviewStatusLabelKey(status: unknown): string {
  switch (normalizeAbsenceReviewStatus(status)) {
    case "PENDING_REASON":
      return "absence.status.pendingReason";
    case "PENDING_REVIEW":
      return "absence.status.pendingReview";
    case "EXCUSED":
      return "absence.status.excused";
    case "UNEXCUSED":
      return "absence.status.unexcused";
    case "NO_ACTION_REQUIRED":
      return "absence.status.noAction";
    default:
      return "absence.status.unknown";
  }
}

export function absenceHoldStatusLabelKey(status: unknown): string {
  return String(status ?? "").toUpperCase() === "ACTIVE"
    ? "absence.hold.active"
    : "absence.hold.resolved";
}
