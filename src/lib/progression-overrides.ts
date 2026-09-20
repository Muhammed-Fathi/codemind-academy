// CodeMind Academy — Phase H: the ADMIN progression override store.
//
// AN OVERRIDE IS AN EXCEPTION, NEVER AN ACADEMIC FACT
// ===================================================
// Approved decision #11. The row says: "this student may continue past the
// progression boundary that would otherwise stop them at this lesson". It
// never:
//   * fabricates a quiz pass          (no QuizAttempt row is written or edited)
//   * fabricates a homework submission(no HomeworkSubmission row is touched)
//   * fabricates video completion     (no LessonProgress / SessionVideoView row)
//   * rewrites attendance history     (Phase F owns Attendance + AbsenceReview)
//   * destroys an AbsenceHold         (the hold stays ACTIVE and visible to
//                                      Admin / Teacher / Parent)
//   * rewrites a historical COMPLETED state
// Underneath the exception every academic fact stays exactly as it was, and
// every reader keeps showing it.
//
// WHY IT IS ADMIN-ONLY (and why TEACHER is refused)
// =================================================
// A teacher's authority is content and grading, not access. Phase H therefore
// hard-codes the role check in this module (`canIssueProgressionOverride`) so
// a future route cannot forget it, and the write functions accept an
// `actorRole` they re-check themselves — the HTTP layer is never the only gate.
//
// AUDIT
// =====
// Every write mirrors into the platform `AuditLog` with the actor, the
// student, the lesson, the reason and the instant, and the row itself carries
// `createdByUserId` / `createdAt` (and, on revocation, `revokedByUserId` /
// `revokedAt` / `revokeReason`). A revoked or expired row is NEVER deleted:
// the history of the decision is the point.

import { db } from "@/lib/db";
import { additiveDelegate } from "@/lib/progression-holds";

type Client = typeof db;

export const PROGRESSION_OVERRIDE_REASON_MIN_LENGTH = 3;
export const PROGRESSION_OVERRIDE_REASON_MAX_LENGTH = 500;

export const OVERRIDE_AUDIT_CREATED = "PROGRESSION_OVERRIDE_CREATED";
export const OVERRIDE_AUDIT_REVOKED = "PROGRESSION_OVERRIDE_REVOKED";

/** The stored row shape (serialization-friendly: dates stay `Date`). */
export type ProgressionOverrideRow = {
  id: string;
  studentId: string;
  courseId: string | null;
  lessonId: string;
  reason: string;
  createdByUserId: string;
  createdAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
};

/**
 * Who may issue or revoke a progression exception.
 *
 * ADMIN only — and deliberately evaluated on the SERVER-SIDE role of the
 * actor, never on a flag the client sends (the same discipline the absence
 * decision and the attendance correction use).
 */
export function canIssueProgressionOverride(role: unknown): boolean {
  return String(role ?? "").trim().toUpperCase() === "ADMIN";
}

export type ReasonValidation =
  | { ok: true; reason: string }
  | { ok: false; code: "REASON_REQUIRED" | "REASON_TOO_SHORT" | "REASON_TOO_LONG" };

/** The reason is MANDATORY: an unlock with no justification is not auditable. */
export function validateOverrideReason(raw: unknown): ReasonValidation {
  if (typeof raw !== "string") return { ok: false, code: "REASON_REQUIRED" };
  const reason = raw.replace(/\s+/g, " ").trim();
  if (reason.length === 0) return { ok: false, code: "REASON_REQUIRED" };
  if (reason.length < PROGRESSION_OVERRIDE_REASON_MIN_LENGTH)
    return { ok: false, code: "REASON_TOO_SHORT" };
  if (reason.length > PROGRESSION_OVERRIDE_REASON_MAX_LENGTH)
    return { ok: false, code: "REASON_TOO_LONG" };
  return { ok: true, reason };
}

export type ExpiryValidation =
  | { ok: true; expiresAt: Date | null }
  | { ok: false; code: "EXPIRY_INVALID" | "EXPIRY_IN_PAST" };

/**
 * The expiry is OPTIONAL. `null` / `""` means "valid until revoked"; anything
 * else must be a real instant in the FUTURE (an override that is already in
 * the past at creation time is a mistake, not an unlock).
 */
export function validateOverrideExpiry(
  raw: unknown,
  now: Date = new Date()
): ExpiryValidation {
  if (raw === null || raw === undefined || raw === "") return { ok: true, expiresAt: null };
  const date = raw instanceof Date ? raw : new Date(String(raw));
  if (Number.isNaN(date.getTime())) return { ok: false, code: "EXPIRY_INVALID" };
  if (date.getTime() <= now.getTime()) return { ok: false, code: "EXPIRY_IN_PAST" };
  return { ok: true, expiresAt: date };
}

/**
 * Is this override in force RIGHT NOW?
 *
 * Pure and clock-injected: an expired row keeps existing (history) but stops
 * applying the instant it expires — no background job, no mutation, so the
 * verdict is deterministic for every reader at every instant.
 */
export function isOverrideValid(
  row: Pick<ProgressionOverrideRow, "revokedAt" | "expiresAt">,
  now: Date
): boolean {
  if (row.revokedAt) return false;
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/** Load every override of a student (history included — validity is computed). */
export async function loadStudentOverrides(
  studentId: string,
  client: Client = db
): Promise<ProgressionOverrideRow[]> {
  // `ProgressionOverride` is additive (Phase H). No delegate ⇒ no override,
  // which is the pre-Phase-H state — see `additiveDelegate`.
  const overrides = additiveDelegate(client, "progressionOverride");
  if (!overrides) return [];
  const rows = await overrides.findMany({
    where: { studentId },
    orderBy: { createdAt: "asc" },
  });
  return (rows ?? []).map(toRow);
}

function toRow(r: any): ProgressionOverrideRow {
  return {
    id: r.id,
    studentId: r.studentId,
    courseId: r.courseId ?? null,
    lessonId: r.lessonId,
    reason: r.reason,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt ?? null,
    expiresAt: r.expiresAt ?? null,
    revokedAt: r.revokedAt ?? null,
    revokedByUserId: r.revokedByUserId ?? null,
    revokeReason: r.revokeReason ?? null,
  };
}

/** The currently-valid override for one lesson, if any. */
export function findValidOverride(
  rows: readonly ProgressionOverrideRow[],
  lessonId: string,
  now: Date
): ProgressionOverrideRow | null {
  return (
    rows.find((r) => r.lessonId === lessonId && isOverrideValid(r, now)) ?? null
  );
}

export type CreateOverrideInput = {
  studentId: string;
  lessonId: string;
  courseId?: string | null;
  reason: unknown;
  expiresAt?: unknown;
  actorUserId: string;
  /** Re-checked here — the HTTP layer must never be the only gate. */
  actorRole: unknown;
  now?: Date;
  client?: Client;
};

export type CreateOverrideResult = {
  override: ProgressionOverrideRow;
  /** false when an IDENTICAL valid override already existed (idempotent). */
  created: boolean;
};

export type OverrideFailureCode =
  | "NOT_AUTHORIZED"
  | "REASON_REQUIRED"
  | "REASON_TOO_SHORT"
  | "REASON_TOO_LONG"
  | "EXPIRY_INVALID"
  | "EXPIRY_IN_PAST"
  | "OVERRIDE_NOT_FOUND";

export class ProgressionOverrideError extends Error {
  code: OverrideFailureCode;
  status: number;
  constructor(code: OverrideFailureCode, message: string, status = 400) {
    super(message);
    this.name = "ProgressionOverrideError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Issue an override. IDEMPOTENT: at most one currently-valid row may exist
 * per (student, lesson), so a double-click or a retried request returns the
 * existing row instead of stacking a second exception on the same boundary.
 */
export async function createProgressionOverride(
  input: CreateOverrideInput
): Promise<CreateOverrideResult> {
  const client = (input.client ?? db) as any;
  const now = input.now ?? new Date();

  if (!canIssueProgressionOverride(input.actorRole)) {
    throw new ProgressionOverrideError(
      "NOT_AUTHORIZED",
      "Only an admin may issue a progression override",
      403
    );
  }
  const reason = validateOverrideReason(input.reason);
  if (!reason.ok) {
    throw new ProgressionOverrideError(
      reason.code,
      "A progression override requires a reason",
      400
    );
  }
  const expiry = validateOverrideExpiry(input.expiresAt, now);
  if (!expiry.ok) {
    throw new ProgressionOverrideError(
      expiry.code,
      "The override expiry must be a valid future instant",
      400
    );
  }
  if (!input.studentId || !input.lessonId) {
    throw new ProgressionOverrideError(
      "REASON_REQUIRED",
      "A student and a lesson are required",
      400
    );
  }

  const existing = await client.progressionOverride.findMany({
    where: { studentId: input.studentId, lessonId: input.lessonId },
    orderBy: { createdAt: "asc" },
  });
  const stillValid = (existing ?? [])
    .map(toRow)
    .find((r: ProgressionOverrideRow) => isOverrideValid(r, now));
  if (stillValid) return { override: stillValid, created: false };

  const created = await client.progressionOverride.create({
    data: {
      studentId: input.studentId,
      lessonId: input.lessonId,
      courseId: input.courseId ?? null,
      reason: reason.reason,
      createdByUserId: input.actorUserId,
      createdAt: now,
      expiresAt: expiry.expiresAt,
    },
  });

  await audit(client, {
    userId: input.actorUserId,
    action: OVERRIDE_AUDIT_CREATED,
    entity: "ProgressionOverride",
    entityId: String(created.id),
    details: {
      overrideId: created.id,
      studentId: input.studentId,
      lessonId: input.lessonId,
      courseId: input.courseId ?? null,
      reason: reason.reason,
      expiresAt: expiry.expiresAt ? expiry.expiresAt.toISOString() : null,
    },
  });

  return { override: toRow(created), created: true };
}

/**
 * Revoke an override. Idempotent: revoking an already-revoked (or already
 * expired) row reports the row unchanged instead of failing, so a retried
 * request cannot produce a second audit event for the same decision.
 */
export async function revokeProgressionOverride(input: {
  overrideId: string;
  actorUserId: string;
  actorRole: unknown;
  reason?: unknown;
  now?: Date;
  client?: Client;
}): Promise<{ override: ProgressionOverrideRow; revoked: boolean }> {
  const client = (input.client ?? db) as any;
  const now = input.now ?? new Date();

  if (!canIssueProgressionOverride(input.actorRole)) {
    throw new ProgressionOverrideError(
      "NOT_AUTHORIZED",
      "Only an admin may revoke a progression override",
      403
    );
  }
  const row = await client.progressionOverride.findUnique({
    where: { id: input.overrideId },
  });
  if (!row) {
    throw new ProgressionOverrideError(
      "OVERRIDE_NOT_FOUND",
      "Progression override not found",
      404
    );
  }
  const current = toRow(row);
  if (current.revokedAt) return { override: current, revoked: false };

  const note = validateOverrideReason(input.reason);
  const updated = await client.progressionOverride.update({
    where: { id: current.id },
    data: {
      revokedAt: now,
      revokedByUserId: input.actorUserId,
      revokeReason: note.ok ? note.reason : null,
    },
  });

  await audit(client, {
    userId: input.actorUserId,
    action: OVERRIDE_AUDIT_REVOKED,
    entity: "ProgressionOverride",
    entityId: current.id,
    details: {
      overrideId: current.id,
      studentId: current.studentId,
      lessonId: current.lessonId,
      reason: note.ok ? note.reason : null,
      wasExpired: current.expiresAt ? current.expiresAt.getTime() <= now.getTime() : false,
    },
  });

  return { override: toRow(updated), revoked: true };
}

/** Best-effort audit mirror (never blocks the write it records). */
async function audit(
  client: any,
  entry: {
    userId: string;
    action: string;
    entity: string;
    entityId: string;
    details: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await client.auditLog.create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        details: JSON.stringify(entry.details).slice(0, 1000),
      },
    });
  } catch {
    // The platform treats the audit log as best-effort everywhere else too:
    // a missing audit row must never roll back an administrative decision.
  }
}

/**
 * The shape student/staff surfaces may see (no internal ids beyond the row).
 *
 * The two ACTOR ids are carried through so an admin console can render "by
 * <name>" without a second source of truth: the decision, its author, its
 * instant and its (optional) revocation always travel together. Names are
 * resolved by the caller from `User`; this module stays persistence-only and
 * never invents a display name.
 */
export type ProgressionOverrideView = {
  id: string;
  lessonId: string;
  courseId: string | null;
  reason: string;
  createdByUserId: string;
  createdAt: string | null;
  expiresAt: string | null;
  valid: boolean;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
};

export function toOverrideView(
  row: ProgressionOverrideRow,
  now: Date
): ProgressionOverrideView {
  return {
    id: row.id,
    lessonId: row.lessonId,
    courseId: row.courseId,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    valid: isOverrideValid(row, now),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedByUserId: row.revokedByUserId ?? null,
    revokeReason: row.revokeReason ?? null,
  };
}
