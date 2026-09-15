// CodeMind Academy — Lesson Quiz RETRY GRANTS (Phase 26D).
//
// The single authority for "may this student take this quiz again?".
//
// THE BUSINESS RULE
//   One student gets ONE attempt per Lesson Quiz. The only way to exceed that is
//   an explicit, attributed, single-use permission issued by an ADMIN. Not by a
//   teacher, not by the student, not by refreshing, not by submitting twice.
//
// WHY THIS IS A MODEL AND NOT A FLAG
//   A retry is a permission issued BEFORE the attempt exists, by someone who is
//   not the student. The two cheap alternatives were both rejected outright:
//     * setting `finishedAt = null` on the old attempt destroys the result the
//       retry is being granted *from*;
//     * deleting the old attempt destroys the student's history.
//   `QuizRetryGrant` adds a row and touches nothing.
//
// LIFECYCLE
//   granted  → an Admin POSTs; the row exists with `consumedAt = null` and a
//              `QUIZ_RETRY_GRANTED` audit entry naming the actor.
//   consumed → the student STARTS the new attempt; `consumedAt` is stamped and
//              the attempt records `retryGrantId`. The grant is spent.
//   spent    → it can never be spent again. One grant = exactly one attempt.
//
// Nothing here reads a request body for a student id, a quiz id, an attempt
// number or a grant id: every one of those is resolved by the caller from the
// session and from validated existence checks.

import { db } from "@/lib/db";

/** Bound on the optional reason text — bounded, not free-form unbounded. */
export const RETRY_REASON_MAX = 500;

export const RETRY_AUDIT_ACTION = "QUIZ_RETRY_GRANTED";

/** Normalise the optional reason: trimmed, length-bounded, nullable. */
export function normalizeRetryReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (s.length === 0) return null;
  return s.slice(0, RETRY_REASON_MAX);
}

export type GrantIssueResult =
  | { ok: true; grantId: string; alreadyPending: false }
  /**
   * A grant for this student+quiz is already unconsumed. Refused rather than
   * stacked: two pending grants would silently mean two extra attempts, and the
   * operator almost certainly clicked twice. The existing grant is returned so
   * the surface can show the truth instead of an error that hides it.
   */
  | { ok: false; code: "ALREADY_PENDING"; grantId: string };

/**
 * Issue exactly one additional attempt to one student on one quiz.
 *
 * Existence of the student and quiz, and the Admin-ness of the caller, are
 * established by the route BEFORE this is called; this function owns the
 * duplicate rule, the row and the audit entry.
 */
export async function issueRetryGrant(opts: {
  studentId: string;
  quizId: string;
  grantedByUserId: string;
  reason?: unknown;
}): Promise<GrantIssueResult> {
  const { studentId, quizId, grantedByUserId } = opts;
  const reason = normalizeRetryReason(opts.reason);

  const pending = await db.quizRetryGrant.findFirst({
    where: { studentId, quizId, consumedAt: null },
    orderBy: { grantedAt: "desc" },
    select: { id: true },
  });
  if (pending) {
    return { ok: false, code: "ALREADY_PENDING", grantId: pending.id };
  }

  const grant = await db.quizRetryGrant.create({
    data: { studentId, quizId, grantedByUserId, reason },
    select: { id: true },
  });

  // Audit is best-effort: a failed audit write must not roll back a permission
  // the operator just issued, and the grant row is itself the primary record.
  await db.auditLog
    .create({
      data: {
        userId: grantedByUserId,
        action: RETRY_AUDIT_ACTION,
        entity: "QuizRetryGrant",
        entityId: grant.id,
        details: JSON.stringify({ studentId, quizId, reason }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return { ok: true, grantId: grant.id, alreadyPending: false };
}

/** How many unconsumed grants this student holds on this quiz. */
export async function countPendingRetryGrants(
  studentId: string,
  quizId: string
): Promise<number> {
  return db.quizRetryGrant.count({
    where: { studentId, quizId, consumedAt: null },
  });
}

/**
 * Spend the oldest unconsumed grant for this student+quiz and tie it to the
 * attempt it permitted. Returns the grant id, or null when there was none
 * (i.e. this attempt is within the quiz's normal allowance).
 *
 * Called from inside the attempt-creation transaction, so a grant cannot be
 * spent twice by two concurrent starts.
 */
export async function consumeRetryGrant(
  tx: Pick<typeof db, "quizRetryGrant">,
  opts: { studentId: string; quizId: string; attemptId: string; now?: Date }
): Promise<string | null> {
  const grant = await tx.quizRetryGrant.findFirst({
    where: { studentId: opts.studentId, quizId: opts.quizId, consumedAt: null },
    orderBy: { grantedAt: "asc" },
    select: { id: true },
  });
  if (!grant) return null;
  await tx.quizRetryGrant.update({
    where: { id: grant.id },
    data: { consumedAt: opts.now ?? new Date() },
  });
  return grant.id;
}
