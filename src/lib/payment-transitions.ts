// CodeMind Academy — Phase 25 PR2b: the payment DECISION layer.
//
// THE CONTRACT (v2 decisions)
//   A Payment is a REQUEST. Only an ADMIN decision turns a request into an
//   entitlement:
//
//     PENDING → APPROVED   (atomic activation / renewal / (re)seat)
//     PENDING → REJECTED   (atomic rejection + coupon release)
//
//   Nothing else may transition a payment:
//     APPROVED → REJECTED, REJECTED → APPROVED, APPROVED → APPROVED,
//     REJECTED → REJECTED, EXPIRED → APPROVED, EXPIRED → REJECTED are ALL
//     forbidden and return INVALID_TRANSITION — a repeated decision is
//     never silently treated as success.
//
//   APPROVAL derives every entitlement value from the PAYMENT ROW, never
//   from the client:
//     * plan  ← Payment.requestedPlanId (or the student's current plan ONLY
//               while that entitlement is still valid — otherwise
//               PLAN_REQUIRED; a missing/unknown/inactive plan is
//               PLAN_NOT_FOUND);
//     * group ← (validated admin override) → Payment.requestedGroupId →
//               Student.groupId → otherwise GROUP_REQUIRED;
//     * user  ← Payment.userId (the Student is resolved from it; NO_STUDENT
//               when the user has no Student row — approval never creates
//               one);
//     * dates ← the plan's own duration (SubscriptionPlan.durationMonths),
//               stacked on the CURRENT endDate for an active renewal, reset
//               to the decision time for every fresh activation.
//
//   The stale-payment rule (PR2a's newest-first read contract made
//   authoritative): a PENDING payment may only be decided while it is the
//   NEWEST pending request of its user — `createdAt DESC, id DESC` (the
//   same ordering the student read API uses). A newer pending request makes
//   the older one STALE_PAYMENT: nothing is mutated, the newer request stays
//   authoritative, no row is destroyed.
//
//   Capacity is ENFORCED here, not at submission (PR2a's pre-check is
//   advisory). A seat is needed only when the student's current group
//   differs from the target (`needsSeat`). When a seat is needed, the
//   approval takes the per-group PostgreSQL advisory lock
//   (`acquireGroupSeatLock`, Phase 23 pattern generalized in
//   `src/lib/db-serialization.ts`), re-reads the group's capacity/member
//   count UNDER the lock, and fails GROUP_FULL when there is no room —
//   same-group renewals never consume a seat and approve even at capacity.
//
//   THE SUBSCRIPTION SINGLETON (Student.subscription, studentId @unique):
//     * it already exists  → it is UPDATEd (PENDING / EXPIRED / CANCELLED /
//       lazily-expired ACTIVE all become the single ACTIVE row);
//     * it does not exist   → it is CREATED (the LEGACY GRANDFATHERED case:
//       the payment arrived with subscriptionId = NULL and no row was ever
//       manufactured at submission — approval is the ONLY moment the row is
//       born).
//   A second row is impossible by constraint and is never attempted.
//
//   TRANSACTION BOUNDARY: every read that drives a write happens INSIDE the
//   single `db.$transaction`; every write the decision performs happens
//   inside it; the audit log row is the LAST write of the transaction, so a
//   failed audit aborts the decision exactly like any other failed step.
//   Post-commit side effects (Phase 12 batch reconciliation, the
//   post-decision notification) are the ROUTE's job — they run after the
//   transaction settles, are failure-tolerant, and can never un-commit the
//   decision (see the approve/reject routes).
//
//   COUPONS: submission consumes a coupon atomically (redemption row +
//   usedCount increment, PR2a). Rejection reverses that consumption in the
//   SAME transaction (redemption deleted, usedCount decremented) so a
//   rejected payment never double-blocks the coupon. Approval preserves the
//   consumed state. The transition guard makes both operations idempotent
//   under forbidden repeated decisions.
//
// Dual-engine: plain Prisma CRUD + the provider-gated advisory lock (a
// deliberate NO-OP on SQLite, which serializes through its single-writer
// database lock). No schema change — every column written here exists since
// PR1's `20260914120000_payment_lifecycle_redesign` migration.
//
// `db` is injected (same convention as `payment-submission.ts`), so the
// behavioural tests execute this exact shipped code.

import {
  acquireGroupSeatLock,
  resolveDatabaseProvider,
} from "@/lib/db-serialization";
import {
  evaluateAccessDecision,
  isSubscriptionValidForAccess,
} from "@/lib/subscription-entitlement";
import { groupTrackScopeEligible } from "@/lib/track-scope";

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

/**
 * The closed set of decision-layer failure codes. Every code maps to a
 * deterministic HTTP status + i18n message in the routes (see
 * `TRANSITION_ERROR_STATUS` / `TRANSITION_ERROR_I18N_KEY`); raw
 * Prisma/database errors never leak to clients.
 */
export const PAYMENT_TRANSITION_ERROR_CODES = [
  "PAYMENT_NOT_FOUND",
  "INVALID_TRANSITION",
  "STALE_PAYMENT",
  "NO_STUDENT",
  "GROUP_REQUIRED",
  "GROUP_NOT_FOUND",
  "GROUP_FULL",
  "PLAN_REQUIRED",
  "PLAN_NOT_FOUND",
  "GROUP_TRACK_MISMATCH",
  "INVALID_GROUP_CONTEXT",
  "INVALID_REJECTION_REASON",
] as const;

export type PaymentTransitionErrorCode =
  (typeof PAYMENT_TRANSITION_ERROR_CODES)[number];

export class PaymentTransitionError extends Error {
  readonly code: PaymentTransitionErrorCode;
  constructor(code: PaymentTransitionErrorCode) {
    super(code);
    this.name = "PaymentTransitionError";
    this.code = code;
  }
}

const fail = (code: PaymentTransitionErrorCode): never => {
  throw new PaymentTransitionError(code);
};

/**
 * Deterministic HTTP status per domain code. `PAYMENT_NOT_FOUND` is a real
 * 404; `INVALID_REJECTION_REASON` is a body-validation 400; every other code
 * is a 409 CONFLICT — the payment exists but cannot be decided in this
 * state (the admin can correct the context and retry; nothing is mutated).
 */
export const TRANSITION_ERROR_STATUS: Record<
  PaymentTransitionErrorCode,
  number
> = {
  PAYMENT_NOT_FOUND: 404,
  INVALID_REJECTION_REASON: 400,
  INVALID_TRANSITION: 409,
  STALE_PAYMENT: 409,
  NO_STUDENT: 409,
  GROUP_REQUIRED: 409,
  GROUP_NOT_FOUND: 409,
  GROUP_TRACK_MISMATCH: 409,
  GROUP_FULL: 409,
  PLAN_REQUIRED: 409,
  PLAN_NOT_FOUND: 409,
  INVALID_GROUP_CONTEXT: 409,
};

/** i18n key per domain code (ar+en in `src/lib/i18n-dict-2026.ts`). */
export const TRANSITION_ERROR_I18N_KEY: Record<
  PaymentTransitionErrorCode,
  string
> = {
  PAYMENT_NOT_FOUND: "api.025", // existing "Payment not found"
  INVALID_TRANSITION: "api.269",
  STALE_PAYMENT: "api.270",
  NO_STUDENT: "api.271",
  GROUP_REQUIRED: "api.272",
  GROUP_NOT_FOUND: "api.273",
  GROUP_TRACK_MISMATCH: "api.286",
  GROUP_FULL: "api.274",
  PLAN_REQUIRED: "api.275",
  PLAN_NOT_FOUND: "api.276",
  INVALID_GROUP_CONTEXT: "api.277",
  INVALID_REJECTION_REASON: "api.278",
};

/**
 * Map a decision-layer outcome to a PLAIN response descriptor (no
 * `next/server` dependency — the routes build the actual Response).
 *
 *   * domain error     → deterministic status + machine-readable `code` +
 *     localized message (the `code` convention `denyProgression` established);
 *   * recognized transient database conflict (SQLite single-writer
 *     contention, spec §31) → 409 `DB_CONFLICT` — honest "retry", nothing
 *     was mutated (the transaction rolled back);
 *   * anything else    → a generic 500 that never leaks Prisma/database
 *     internals to the client.
 */
export function transitionErrorDecision(
  t: (key: string, params?: Record<string, unknown>) => string,
  e: unknown
): { status: number; message: string; code: string } {
  if (e instanceof PaymentTransitionError) {
    return {
      status: TRANSITION_ERROR_STATUS[e.code],
      message: t(TRANSITION_ERROR_I18N_KEY[e.code]),
      code: e.code,
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  if (/SQLITE_(BUSY|LOCKED)|database is locked/i.test(message)) {
    return { status: 409, message: t("api.279"), code: "DB_CONFLICT" };
  }
  console.error("[payment-decision] unexpected error:", e);
  return { status: 500, message: t("api.284"), code: "INTERNAL" };
}

// ---------------------------------------------------------------------------
// Rejection reason
// ---------------------------------------------------------------------------

export const REJECTION_REASON_MAX_LENGTH = 500;

/**
 * Normalize a rejection reason: trim + collapse inner whitespace. Returns
 * null when the value is missing, blank after trim, or longer than 500
 * characters — the caller maps null to INVALID_REJECTION_REASON.
 */
export function normalizeRejectionReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (!collapsed) return null;
  if (collapsed.length > REJECTION_REASON_MAX_LENGTH) return null;
  return collapsed;
}

// ---------------------------------------------------------------------------
// Date math — the plan's own duration representation
// ---------------------------------------------------------------------------

/**
 * Add calendar months to a date using the repository's duration
 * representation (`SubscriptionPlan.durationMonths`), with day-overflow
 * CLAMPED to the target month's last day (Jan 31 + 1 month = Feb 28, never
 * Mar 3). This is pure and deterministic — the tests pin the exact results.
 *
 * SUBSCRIPTION TIMESTAMPS ARE ABSOLUTE UTC INSTANTS. All arithmetic here is
 * therefore done with the UTC accessors (`getUTC*`) and `Date.UTC` ONLY —
 * never with the local-time accessors (`getMonth` / `setDate` / …) or the
 * local-time `new Date(y, m, d)` constructor. Local-time month arithmetic
 * reinterprets the same wall-clock fields under the SERVER's timezone, so
 * whenever the source and target months fall on opposite sides of a DST
 * transition the resulting instant is shifted by the offset delta (e.g.
 * Africa/Cairo: 2026-10-01T00:00:00Z + 1 month produced
 * 2026-11-01T01:00:00Z — Egypt leaves DST on the last Thursday of October,
 * so UTC+3 became UTC+2 and the extra hour leaked into the stored endDate).
 * The UTC form is invariant to the machine's TZ: the time-of-day and the
 * calendar day are preserved exactly, so
 * 2026-10-01T00:00:00.000Z + 1 month === 2026-11-01T00:00:00.000Z
 * under every timezone. `base` is never mutated.
 */
export function addMonths(base: Date, months: number): Date {
  // Calendar fields of the absolute instant, read in UTC.
  const totalMonth = base.getUTCMonth() + months;
  // Normalize so a negative `months` walks backwards across year boundaries.
  const targetYear = base.getUTCFullYear() + Math.floor(totalMonth / 12);
  const targetMonth = ((totalMonth % 12) + 12) % 12;

  // Day-clamping rule (unchanged): the target month's last day is day 0 of
  // the following month. `Date.UTC` normalizes both the month and day-0
  // overflow without any local-time or DST reinterpretation.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(base.getUTCDate(), lastDay),
      base.getUTCHours(),
      base.getUTCMinutes(),
      base.getUTCSeconds(),
      base.getUTCMilliseconds()
    )
  );
}

// ---------------------------------------------------------------------------
// Shared transactional resolution helpers (approval)
// ---------------------------------------------------------------------------

type TxLike = {
  payment: any;
  student: any;
  subscription: any;
  subscriptionPlan: any;
  group: any;
  auditLog: any;
  coupon: any;
  couponRedemption: any;
};

const PAYMENT_DECISION_SELECT = {
  id: true,
  userId: true,
  status: true,
  subscriptionId: true,
  requestedGroupId: true,
  requestedPlanId: true,
  createdAt: true,
} as const;

const STUDENT_APPROVAL_SELECT = {
  id: true,
  userId: true,
  groupId: true,
  // Phase 26B — the group-audience eligibility input for
  // `resolveTargetGroupForApproval` (student side of the exact-match rule).
  schoolType: true,
  group: { select: { id: true, isActive: true, courseId: true } },
  subscription: {
    select: { id: true, status: true, planId: true, startDate: true, endDate: true },
  },
} as const;

/**
 * Re-read the payment INSIDE the transaction and enforce the strict
 * transition guard: only PENDING may be decided.
 */
async function readPendingPayment(tx: TxLike, paymentId: string) {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: PAYMENT_DECISION_SELECT,
  });
  if (!payment) fail("PAYMENT_NOT_FOUND");
  if (String(payment.status).toUpperCase() !== "PENDING") {
    fail("INVALID_TRANSITION");
  }
  return payment;
}

/**
 * Resolve the Student from `Payment.userId` — never from the client.
 * Approval NEVER creates a student row.
 */
async function resolveStudentForPayment(tx: TxLike, userId: string) {
  const student = await tx.student.findUnique({
    where: { userId },
    select: STUDENT_APPROVAL_SELECT,
  });
  if (!student) fail("NO_STUDENT");
  return student;
}

/**
 * STALE-PAYMENT GUARD (spec §9). The newest pending request of the user wins:
 * ordered `createdAt DESC`, tie-broken `id DESC` — byte-for-byte the ordering
 * PR2a's student read API uses (`[{createdAt:"desc"},{id:"desc"}]`). The
 * target payment is stale when ANY other PENDING row of the same user sorts
 * strictly before it in that order. Nothing is destroyed: the older rows
 * stay PENDING (history), the newer request remains authoritative.
 */
async function assertNotStalePendingPayment(
  tx: TxLike,
  payment: { id: string; userId: string; createdAt: Date }
): Promise<void> {
  const newer = await tx.payment.findFirst({
    where: {
      userId: payment.userId,
      status: "PENDING",
      NOT: { id: payment.id },
      OR: [
        { createdAt: { gt: payment.createdAt } },
        { AND: [{ createdAt: payment.createdAt }, { id: { gt: payment.id } }] },
      ],
    },
    select: { id: true },
  });
  if (newer) fail("STALE_PAYMENT");
}

/**
 * PLAN RESOLUTION (spec §7). Order:
 *   1. `Payment.requestedPlanId` (the request's own intent);
 *   2. the student's CURRENT plan — ONLY while the current entitlement is
 *      still valid (a truthful, unambiguous renewal of what they already
 *      pay for). Anything else with a missing requested plan is
 *      PLAN_REQUIRED: legacy rows without plan intent can never produce a
 *      false successful activation.
 * The resolved plan must exist and be ACTIVE (the current business rule for
 * a usable plan).
 */
async function resolvePlanForApproval(
  tx: TxLike,
  payment: { requestedPlanId: unknown },
  student: { subscription: unknown },
  now: Date
) {
  let planId: string | null =
    typeof payment.requestedPlanId === "string" && payment.requestedPlanId
      ? payment.requestedPlanId
      : null;
  if (!planId) {
    // The current entitlement row (as read by the caller, incl. `status`):
    // the fallback is ONLY while that entitlement is currently valid.
    const sub = (student.subscription ?? null) as {
      status: unknown;
      planId?: string;
      startDate?: unknown;
      endDate?: unknown;
    } | null;
    if (
      sub &&
      typeof sub.planId === "string" &&
      sub.planId &&
      isSubscriptionValidForAccess(sub, now)
    ) {
      planId = sub.planId;
    } else {
      fail("PLAN_REQUIRED");
    }
  }
  const plan = await tx.subscriptionPlan.findUnique({
    where: { id: planId },
    select: { id: true, isActive: true, durationMonths: true },
  });
  if (!plan || plan.isActive !== true) fail("PLAN_NOT_FOUND");
  return plan;
}

/**
 * TARGET-GROUP RESOLUTION (spec §6). Order:
 *   1. the explicit (validated) admin override, when provided;
 *   2. `Payment.requestedGroupId`;
 *   3. the student's current `Student.groupId`;
 *   4. otherwise GROUP_REQUIRED — approval fails safely and the admin/UI can
 *      resolve the decision context later (the override IS the recovery path
 *      for exactly this state).
 *
 * The target must EXIST and be ACTIVE (the enrollment business rule; an
 * inactive or dangling group reads GROUP_NOT_FOUND — the same "group not
 * available" refusal F-04 established for submissions, so the response never
 * distinguishes missing from deactivated).
 *
 * COURSE CONTEXT: the payment's request context is the course of the group
 * it requested (when that group exists) and/or the course of the student's
 * current group — whichever differs from the chosen target. The target must
 * stay inside that context (INVALID_GROUP_CONTEXT). A brand-new request with
 * no other context (new student, target = its own requested group) has
 * nothing to violate: the requested group IS the context.
 */
async function resolveTargetGroupForApproval(
  tx: TxLike,
  payment: { requestedGroupId: unknown },
  student: { groupId: unknown; schoolType: unknown },
  overrideGroupId: string | null
) {
  let candidateId: string | null = null;
  if (overrideGroupId) candidateId = overrideGroupId;
  if (!candidateId && payment.requestedGroupId)
    candidateId = String(payment.requestedGroupId);
  if (!candidateId && student.groupId) candidateId = String(student.groupId);
  if (!candidateId) fail("GROUP_REQUIRED");

  const target = await tx.group.findUnique({
    where: { id: candidateId },
    // Phase 26B — `trackScope` feeds the audience-compatibility guard below.
    select: { id: true, name: true, isActive: true, courseId: true, capacity: true, trackScope: true },
  });
  if (!target || target.isActive !== true) fail("GROUP_NOT_FOUND");

  // Phase 26B — GROUP AUDIENCE COMPATIBILITY (decision-authority rule).
  // The approval can assign ANY group (requested id or admin override), so
  // THIS is where compatibility is enforced — not in the admin UI: an admin
  // can never approve an ARABIC student into a LANGUAGE group or vice versa,
  // not even via a direct API call. The exact same predicate the submission
  // path uses (`groupTrackScopeEligible`), so the two layers cannot drift.
  //   * unclassified (null) groups are refused for everyone until classified;
  //   * a student whose school type is unknown is refused for every group;
  //   * same-group renewals re-check their (already assigned) group — a
  //     compatible assignment stays compatible; a legacy mismatched one is
  //     refused with GROUP_TRACK_MISMATCH and the operator classifies the
  //     student's school type explicitly first.
  // This fails BEFORE the seat lock and BEFORE any write: no Payment,
  // Subscription, group or audit mutation can half-apply (atomicity intact;
  // capacity/locking/renewal/grandfather semantics untouched).
  if (!groupTrackScopeEligible(student.schoolType, target.trackScope))
    fail("GROUP_TRACK_MISMATCH");

  const contextCourseIds: string[] = [];
  if (payment.requestedGroupId && payment.requestedGroupId !== candidateId) {
    const g = await tx.group.findUnique({
      where: { id: String(payment.requestedGroupId) },
      select: { courseId: true },
    });
    if (g?.courseId) contextCourseIds.push(String(g.courseId));
  }
  if (student.groupId && student.groupId !== candidateId) {
    const g = await tx.group.findUnique({
      where: { id: String(student.groupId) },
      select: { courseId: true },
    });
    if (g?.courseId) contextCourseIds.push(String(g.courseId));
  }
  for (const courseId of contextCourseIds) {
    if (String(target.courseId) !== courseId) fail("INVALID_GROUP_CONTEXT");
  }

  return target;
}

// ---------------------------------------------------------------------------
// APPROVAL
// ---------------------------------------------------------------------------

/**
 * How the decision changed the student's access — drives the TRUTHFUL
 * post-decision notification (spec §26):
 *   ACTIVATED — the student had no valid entitlement before (first
 *               activation or reactivation of an expired/cancelled one):
 *               "subscription activated / content available";
 *   RENEWED   — the student already held a valid ACTIVE entitlement:
 *               "renewed / valid until …" (never "course opened");
 *   CONFIRMED — the student held GRANDFATHERED access (valid group, no
 *               Subscription row): "confirmed / valid until …" (they already
 *               had access; the row now records it truthfully).
 */
export type AccessNotificationKind = "ACTIVATED" | "RENEWED" | "CONFIRMED";

/**
 * The scenario labels — explicit in code and tests (spec §14) about the
 * difference between first activation, active renewal, expired/inactive
 * reactivation and legacy-grandfathered activation.
 */
export type ApprovalScenario =
  | "FIRST_ACTIVATION"
  | "RENEWAL"
  | "REACTIVATION"
  | "GRANDFATHERED_ACTIVATION";

export type ApprovePaymentInput = {
  /** Prisma client (or a surface-compatible fake — tests inject). */
  db: any;
  paymentId: string;
  /** The DECIDING ADMIN's user id, from the authenticated session ONLY. */
  reviewerUserId: string;
  /**
   * Optional admin group override (spec §21) — the API-level recovery path
   * for GROUP_REQUIRED / dangling requested groups. Admin-only (the route
   * enforces ADMIN), fully validated here like any other candidate,
   * capacity-protected when it changes the seat.
   */
  overrideGroupId?: string | null;
  /** Injectable clock (tests); defaults to now. */
  now?: Date;
};

export type ApprovePaymentResult = {
  scenario: ApprovalScenario;
  /** True when endDate was stacked on the prior (future) endDate. */
  stacked: boolean;
  payment: {
    id: string;
    userId: string;
    status: "APPROVED";
    subscriptionId: string;
    reviewedAt: Date;
    reviewedByUserId: string;
  };
  subscription: {
    id: string;
    status: "ACTIVE";
    planId: string;
    startDate: Date;
    endDate: Date;
  };
  student: { id: string; groupId: string | null };
  group: { id: string; courseId: string };
  /** True when Student.groupId changed (a seat was consumed). */
  needsSeat: boolean;
  /** The shared-policy verdict computed BEFORE the write (truthful audit). */
  priorAccessAllowed: boolean;
  priorGrandfathered: boolean;
  /** Which truthful notification the route must send (spec §26). */
  accessNotification: AccessNotificationKind;
  plan: { id: string; durationMonths: number };
};

/**
 * APPROVE a PENDING payment — the ONE atomic unit of approval (spec §10).
 * Every write happens inside a single `db.$transaction`; if any step fails
 * (domain error, constraint, DB error) NONE of the business writes commit.
 *
 * Post-commit steps (batch reconciliation, notification) are deliberately
 * NOT here: the route runs them after the transaction settles, so they can
 * observe only committed state and cannot roll the decision back.
 */
export async function approvePayment(
  input: ApprovePaymentInput
): Promise<ApprovePaymentResult> {
  const { db, paymentId, reviewerUserId } = input;
  const now = input.now ?? new Date();
  const overrideGroupId =
    typeof input.overrideGroupId === "string" && input.overrideGroupId.trim()
      ? input.overrideGroupId.trim()
      : null;
  const provider = resolveDatabaseProvider();

  return db.$transaction(async (tx: any) => {
    // 1-2. Re-read the payment INSIDE the transaction; strict guard.
    const payment = await readPendingPayment(tx, paymentId);

    // 3. Student resolution — ownership from the payment row, never client.
    const student = await resolveStudentForPayment(tx, payment.userId);

    // 4. Stale-payment guard (newest pending request wins).
    await assertNotStalePendingPayment(tx, payment);

    // 5. Plan resolution (truthful plan or PLAN_REQUIRED/PLAN_NOT_FOUND).
    const plan = await resolvePlanForApproval(tx, payment, student, now);

    // 6. Target-group resolution (override → requested → current → required).
    const targetGroup = await resolveTargetGroupForApproval(
      tx,
      payment,
      student,
      overrideGroupId
    );

    // Prior-state snapshot — the shared policy, the SAME function every
    // authorization path uses (scenario + notification truth + audit).
    const priorSub = (student.subscription ?? null) as {
      id: string;
      status: string;
      planId: string;
      startDate: Date | null;
      endDate: Date | null;
    } | null;
    const priorAccess = evaluateAccessDecision(
      {
        groupActive:
          !!student.groupId &&
          student.group?.isActive === true &&
          student.group?.courseId != null,
        subscription: priorSub,
      },
      now
    );
    const activeRenewal = isSubscriptionValidForAccess(priorSub, now);

    // 7. Seat-change decision: only a group CHANGE consumes a seat.
    const needsSeat = student.groupId !== targetGroup.id;

    // 8-10. Serialize + re-read capacity UNDER the lock (PostgreSQL advisory
    // lock, transaction-scoped; SQLite relies on its single-writer lock).
    // A same-group approval skips the lock and the count entirely — it
    // approves even when the group is at capacity (spec §16).
    if (needsSeat) {
      await acquireGroupSeatLock(tx, targetGroup.id, provider);
      const members = await tx.student.count({
        where: { groupId: targetGroup.id },
      });
      if (members >= targetGroup.capacity) fail("GROUP_FULL");
    }

    // 11-13. The Subscription singleton + dates (spec §11–§15):
    //   RENEWAL (ACTIVE + unexpired)      → same row stays ACTIVE, startDate
    //      preserved, endDate STACKED on the current (future) endDate;
    //   REACTIVATION (a row that was PAID before — stored ACTIVE/EXPIRED/
    //      CANCELLED — is now invalid) → same row re-activated, fresh dates
    //      from now;
    //   FIRST_ACTIVATION (no prior paid entitlement — including the student's
    //      own PENDING submission row, which has never been an entitlement)
    //      and GRANDFATHERED_ACTIVATION (no row at all, legacy access) →
    //      the row is created/activated with fresh dates from now
    //      (grandfathered: the legacy access becomes the recorded paid
    //      entitlement with no gap).
    let scenario: ApprovalScenario;
    let stacked = false;
    let startDate: Date;
    let endDate: Date;
    if (activeRenewal && priorSub) {
      scenario = "RENEWAL";
      const base =
        priorSub.endDate && priorSub.endDate.getTime() > now.getTime()
          ? priorSub.endDate
          : now;
      startDate = priorSub.startDate ?? now;
      endDate = addMonths(base, plan.durationMonths);
      stacked = true;
    } else {
      // A PENDING row is the submission's own placeholder — it has never
      // been an entitlement, so it is NOT a reactivation.
      const priorWasPaid =
        !!priorSub && String(priorSub.status).toUpperCase() !== "PENDING";
      scenario = priorWasPaid
        ? "REACTIVATION"
        : priorAccess.grandfathered
          ? "GRANDFATHERED_ACTIVATION"
          : "FIRST_ACTIVATION";
      startDate = now;
      endDate = addMonths(now, plan.durationMonths);
    }

    let subscription: {
      id: string;
      status: string;
      planId: string;
      startDate: Date;
      endDate: Date;
    };
    if (priorSub) {
      subscription = await tx.subscription.update({
        where: { id: priorSub.id },
        data: { status: "ACTIVE", planId: plan.id, startDate, endDate },
        select: { id: true, status: true, planId: true, startDate: true, endDate: true },
      });
    } else {
      subscription = await tx.subscription.create({
        data: {
          studentId: student.id,
          planId: plan.id,
          status: "ACTIVE",
          startDate,
          endDate,
        },
        select: { id: true, status: true, planId: true, startDate: true, endDate: true },
      });
    }

    // 13b. Group assignment ONLY when a seat change is required.
    if (needsSeat) {
      await tx.student.update({
        where: { id: student.id },
        data: { groupId: targetGroup.id },
      });
    }

    // 14-18. The decision itself: APPROVED + reviewer audit fields + the
    // subscription link (ensured when missing — the LEGACY GRANDFATHERED
    // payment arrives with subscriptionId = null and a freshly created row).
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "APPROVED",
        rejectionReason: null,
        reviewedAt: now,
        reviewedByUserId: reviewerUserId,
        subscriptionId: subscription.id,
      },
    });

    // 19. Audit log — INSIDE the transaction (a failed audit aborts the
    // decision). Captures enough to reconstruct the decision: admin,
    // payment, student, subscription, previous group/plan/status, resulting
    // group/plan/status, decision type. No secrets: ids + the admin-authored
    // context only.
    await tx.auditLog.create({
      data: {
        userId: reviewerUserId,
        action: "PAYMENT_APPROVED",
        entity: "Payment",
        entityId: payment.id,
        details: JSON.stringify({
          paymentId: payment.id,
          userId: payment.userId,
          studentId: student.id,
          subscriptionId: subscription.id,
          scenario,
          decision: "APPROVED",
          prior: {
            status: priorSub ? String(priorSub.status) : null,
            planId: priorSub?.planId ?? null,
            endDate: priorSub?.endDate ?? null,
            groupId: student.groupId ?? null,
            accessAllowed: priorAccess.allowed,
            grandfathered: priorAccess.grandfathered,
          },
          after: {
            status: "ACTIVE",
            planId: plan.id,
            endDate: subscription.endDate,
            groupId: needsSeat ? targetGroup.id : student.groupId ?? null,
          },
          groupChanged: needsSeat,
          targetGroupId: targetGroup.id,
          targetCourseId: targetGroup.courseId,
          overrideUsed: overrideGroupId !== null && overrideGroupId === targetGroup.id,
        }).slice(0, 1000),
      },
    });

    const accessNotification: AccessNotificationKind = !priorAccess.allowed
      ? "ACTIVATED"
      : priorAccess.grandfathered
        ? "CONFIRMED"
        : "RENEWED";

    return {
      scenario,
      stacked,
      payment: {
        id: payment.id,
        userId: payment.userId,
        status: "APPROVED" as const,
        subscriptionId: subscription.id,
        reviewedAt: now,
        reviewedByUserId: reviewerUserId,
      },
      subscription: {
        id: subscription.id,
        status: "ACTIVE" as const,
        planId: subscription.planId,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
      },
      student: {
        id: student.id,
        groupId: needsSeat ? targetGroup.id : (student.groupId ?? null),
      },
      group: { id: targetGroup.id, courseId: String(targetGroup.courseId) },
      needsSeat,
      priorAccessAllowed: priorAccess.allowed,
      priorGrandfathered: priorAccess.grandfathered,
      accessNotification,
      plan: { id: plan.id, durationMonths: plan.durationMonths },
    };
  });
}

// ---------------------------------------------------------------------------
// Post-commit side effects (approval) — the ROUTE wires these, the test
// drives them
// ---------------------------------------------------------------------------

/**
 * Run an APPROVAL's post-commit side effects in the fixed order the
 * platform requires (spec §25/§26):
 *
 *   1. Phase 12 batch reconciliation — AFTER the transaction settled, so it
 *      observes committed state only (never partial state);
 *   2. the truthful post-decision notification.
 *
 * Each step is failure-tolerant: a failure is logged and returned as a
 * warning, and this helper NEVER throws — a side-effect failure must not
 * un-commit or falsify a committed decision. The caller (route) runs this
 * strictly after `approvePayment` resolves (i.e. after COMMIT).
 */
export async function runApprovalPostCommitEffects(opts: {
  studentId: string;
  /** Phase 12 `reconcileStudentBatch` — injected so tests can observe/fault it. */
  reconcile: (studentId: string) => Promise<unknown>;
  /** The post-decision notification — injected for the same reason. */
  notify: () => Promise<unknown>;
}): Promise<string[]> {
  const warnings: string[] = [];
  try {
    await opts.reconcile(opts.studentId);
  } catch (e) {
    console.error(
      "[payment-approval] post-commit batch reconciliation failed:",
      e
    );
    warnings.push("reconciliation_failed");
  }
  try {
    await opts.notify();
  } catch (e) {
    console.error("[payment-approval] post-commit notification failed:", e);
    warnings.push("notification_failed");
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// REJECTION
// ---------------------------------------------------------------------------

export type RejectPaymentInput = {
  db: any;
  paymentId: string;
  /** The DECIDING ADMIN's user id, from the authenticated session ONLY. */
  reviewerUserId: string;
  /** Raw reason — normalized (trim + collapse) then length-checked. */
  reason: string;
  /** Injectable clock (tests); defaults to now. */
  now?: Date;
};

export type RejectPaymentResult = {
  payment: {
    id: string;
    userId: string;
    status: "REJECTED";
    rejectionReason: string;
    reviewedAt: Date;
    reviewedByUserId: string;
  };
  /** True when a coupon redemption consumed by this payment was released. */
  couponReleased: boolean;
};

/**
 * REJECT a PENDING payment — the ONE atomic unit of rejection (spec §4).
 *
 * Atomically: Payment → REJECTED with the normalized reason + reviewer
 * audit fields, the coupon redemption (consumed at submission, PR2a) is
 * reversed (redemption deleted, usedCount decremented) so the coupon can
 * never be double-used because of a rejected payment, and the audit log is
 * written. The student's entitlement is NEVER touched: no groupId, no
 * Subscription row (grandfathered students keep their legacy access
 * byte-for-byte), no dates, no existing entitlement.
 *
 * The rejection reason is REQUIRED and validated (non-empty after trim,
 * ≤ 500 chars) — INVALID_REJECTION_REASON when it is not.
 */
export async function rejectPayment(
  input: RejectPaymentInput
): Promise<RejectPaymentResult> {
  const { db, paymentId, reviewerUserId } = input;
  const now = input.now ?? new Date();
  const reason = normalizeRejectionReason(input.reason);
  if (reason === null) fail("INVALID_REJECTION_REASON");

  return db.$transaction(async (tx: any) => {
    // 1-2. Re-read inside the transaction; strict guard (PENDING only).
    const payment = await readPendingPayment(tx, paymentId);

    // 3. Coupon release — the submission consumed the coupon at submit time
    // (redemption row + usedCount increment). Rejection reverses that in the
    // SAME transaction. Idempotency under forbidden repeated transitions is
    // guaranteed by the guard above: a second decision fails BEFORE this
    // code runs, so a coupon can never be released twice.
    let couponReleased = false;
    const redemptions = await tx.couponRedemption.findMany({
      where: { paymentId: payment.id },
      select: { id: true, couponId: true },
    });
    for (const r of redemptions) {
      await tx.couponRedemption.delete({ where: { id: r.id } });
      const coupon = await tx.coupon.findUnique({
        where: { id: r.couponId },
        select: { usedCount: true },
      });
      if (coupon && coupon.usedCount > 0) {
        await tx.coupon.update({
          where: { id: r.couponId },
          data: { usedCount: { decrement: 1 } },
        });
      }
    }
    couponReleased = redemptions.length > 0;

    // 4. The decision: REJECTED + reviewer audit fields. No entitlement,
    // group or date mutation anywhere in this transaction.
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "REJECTED",
        rejectionReason: reason,
        reviewedAt: now,
        reviewedByUserId: reviewerUserId,
      },
    });

    // 5. Audit log — admin, payment, student/user context, reason. Inside
    // the transaction, like approval's.
    const student = await tx.student.findUnique({
      where: { userId: payment.userId },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        userId: reviewerUserId,
        action: "PAYMENT_REJECTED",
        entity: "Payment",
        entityId: payment.id,
        details: JSON.stringify({
          paymentId: payment.id,
          userId: payment.userId,
          studentId: student?.id ?? null,
          decision: "REJECTED",
          reason,
        }).slice(0, 1000),
      },
    });

    return {
      payment: {
        id: payment.id,
        userId: payment.userId,
        status: "REJECTED" as const,
        rejectionReason: reason,
        reviewedAt: now,
        reviewedByUserId: reviewerUserId,
      },
      couponReleased,
    };
  });
}
