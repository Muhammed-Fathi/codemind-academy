// CodeMind Academy — Phase 25 PR2a: payment-intent submission + student payment read.
//
// THE CONTRACT (v2 enrollment)
//   A payment submission records an INTENT on the Payment row
//   (`requestedGroupId` / `requestedPlanId` / `senderPhone` / `reference`) and
//   NOTHING ELSE may be assumed about the student's entitlement:
//
//   * NEW / UNENTITLED student (no group, or a Subscription that is not
//     currently valid): the student's Subscription row becomes / is created
//     PENDING for the requested plan. `Student.groupId` is NOT touched —
//     group assignment happens ONLY when an admin approves (PR2b). Submitting
//     payment must NOT open the course.
//
//   * ACTIVE + UNEXPIRED renewal: the current entitlement is preserved
//     byte-for-byte — status, planId, startDate, endDate and `Student.groupId`
//     all stay untouched; only a new PENDING Payment is written. A renewal
//     request must never downgrade the live entitlement before approval.
//
//   * LEGACY GRANDFATHERED (PR2a audit fix): a student with NO Subscription
//     row whose group half of the central policy passes — `Student.groupId`
//     set, the group EXISTS, is ACTIVE, and is bound to a course — holds
//     legacy access that IS their current entitlement. Submitting a payment
//     must not lock them out: because a Subscription row, once it exists, is
//     authoritative (PENDING ⇒ deny), the ONLY architecture-consistent shape
//     is to create NO Subscription row on this path at all — no create, no
//     PENDING update. The request is Payment history with
//     `subscriptionId = null` (the PR1 ledger column is nullable); creating
//     and activating the singleton is PR2b's approval job (see the PR2a doc
//     §11 handoff). The grandfather predicate is not re-derived here: it is
//     the `grandfathered` verdict of `evaluateAccessDecision`, the SAME
//     function every authorization path uses, so submission and access can
//     never drift apart.
//
// PR2b HANDOFF (mandatory, documented in docs/PHASE_25_PR2A_PAYMENT_LIFECYCLE.md):
//   Approval of a LEGACY_GRANDFATHERED Payment arrives with
//   `payment.subscriptionId === null`. It must then, atomically: resolve the
//   Student from `payment.userId`, resolve the plan from
//   `payment.requestedPlanId`, CREATE + activate the singleton Subscription
//   (ACTIVE, dated), assign `Student.groupId` from
//   `payment.requestedGroupId`, enforce capacity and reconcile batches.
//
// The Subscription is a per-student SINGLETON (`Student.subscription` is a
// one-to-one). Multiple Payment rows are ALLOWED and expected: Payment is
// request history, and read payloads order by `createdAt` so PR2b can refuse
// stale approvals deterministically (newest request wins) — that transition
// logic itself is deliberately NOT implemented here (PR2b owns approve/reject).
//
// Manual launch payment only (InstaPay / e& Cash): no gateway, no screenshot,
// no R2. Validation stays intentionally loose on `reference` (Egyptian
// transaction ids vary wildly) and delegates phone rules to the project's
// existing Egyptian-phone helpers. Duplicate references are NEVER rejected
// here (no unique constraint by design — PR1 §2); the read layer flags them.
//
// Dual-engine safe: plain Prisma CRUD inside ONE `db.$transaction`, no
// PostgreSQL-only constructs (advisory locks / FOR UPDATE belong to PR2b).
// `db` is injected so the behavioural test drives this exact shipped code.

import { isValidEgyptianPhone, normalizePhone } from "@/lib/registration";
import {
  evaluateAccessDecision,
  isSubscriptionValidForAccess,
} from "@/lib/subscription-entitlement";

/** Methods the manual launch supports. VODAFONE_CASH is disabled in the UI. */
export const SUPPORTED_PAYMENT_METHODS = ["INSTAPAY", "ETISALAT_CASH"] as const;
export type SupportedPaymentMethod = (typeof SUPPORTED_PAYMENT_METHODS)[number];

/** All enum members — an unsupported-but-real method gets its own message. */
const KNOWN_PAYMENT_METHODS = new Set([
  ...SUPPORTED_PAYMENT_METHODS,
  "VODAFONE_CASH",
]);

/** Reference hygiene only — deliberately NOT a format rule. */
export const REFERENCE_MIN_LENGTH = 3;
export const REFERENCE_MAX_LENGTH = 64;

/**
 * Normalize a sender phone to the canonical local Egyptian form
 * (`01XXXXXXXXX`). Returns null when the value is not a valid Egyptian
 * mobile number (or is missing). Comparison uses the project's existing
 * `normalizePhone`, so "+20 114 742 2177" and "01147422177" are the same
 * number by construction.
 */
export function normalizeSenderPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const candidate = raw.trim();
  if (!candidate) return null;
  if (!isValidEgyptianPhone(candidate)) return null;
  const digits = normalizePhone(candidate); // "201XXXXXXXXX"
  return digits.startsWith("20") ? `0${digits.slice(2)}` : digits;
}

/**
 * Trim + collapse inner whitespace; keep every other character (legitimate
 * InstaPay / e& references are long digit strings, but the repo must not
 * reject a real bank reference over formatting).
 */
export function normalizePaymentReference(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (
    collapsed.length < REFERENCE_MIN_LENGTH ||
    collapsed.length > REFERENCE_MAX_LENGTH
  ) {
    return null;
  }
  return collapsed;
}

/** Comparison key for duplicate-reference detection (never a uniqueness gate). */
export function referenceComparisonKey(normalizedReference: string): string {
  return normalizedReference.toLowerCase().replace(/[\s-]/g, "");
}

export type ValidatedEnrollmentInput = {
  method: SupportedPaymentMethod;
  senderPhone: string;
  reference: string;
};

/**
 * Validate the Phase-25-required submission fields. Returns `error` (message +
 * status) or the normalized input. Messages come from the caller's translator,
 * so the i18n contract lives in the route layer like every other API error.
 */
export function validateEnrollmentSubmission(
  body: { method?: unknown; senderPhone?: unknown; reference?: unknown },
  t: (key: string, params?: Record<string, unknown>) => string
): { error: { message: string; status: number } } | { input: ValidatedEnrollmentInput } {
  const method = typeof body.method === "string" ? body.method.trim().toUpperCase() : "";
  if (!KNOWN_PAYMENT_METHODS.has(method)) {
    return { error: { message: t("api.082"), status: 400 } };
  }
  if (!(SUPPORTED_PAYMENT_METHODS as readonly string[]).includes(method)) {
    // Known enum member but not open for the manual launch (VODAFONE_CASH).
    return { error: { message: t("api.266"), status: 400 } };
  }

  const senderPhone = normalizeSenderPhone(body.senderPhone);
  if (senderPhone === null) {
    return { error: { message: t("api.267"), status: 400 } };
  }

  const reference = normalizePaymentReference(body.reference);
  if (reference === null) {
    return { error: { message: t("api.268"), status: 400 } };
  }

  return { input: { method: method as SupportedPaymentMethod, senderPhone, reference } };
}

// ---------------------------------------------------------------------------
// Submission core (driven directly by tests against a fake db).
// ---------------------------------------------------------------------------

export type SubmitPaymentRequestParams = {
  db: any;
  userId: string;
  studentId: string;
  /** Validated ACTIVE group of the selected course (route checked binding). */
  groupId: string;
  /** Validated plan row (route checked existence). */
  plan: { id: string; price: number };
  /** Amount already coupon-adjusted by the route (existing business rule). */
  amount: number;
  /** Optional coupon notes text (existing behaviour, `Payment.notes`). */
  notes: string | null;
  /** Validated coupon row id/code for redemption inside the transaction. */
  coupon: { id: string; code: string } | null;
  method: SupportedPaymentMethod;
  senderPhone: string;
  reference: string;
  /** "New subscription request" / "{name} submitted a new request". */
  notify: { title: string; message: string; link: string };
  now?: Date;
};

export type SubmitPaymentRequestResult = {
  /**
   * NEW_REQUEST  — PENDING Subscription row created/maintained (no access).
   * RENEWAL      — ACTIVE+unexpired row preserved; Payment is history only.
   * LEGACY_GRANDFATHERED — grandfathered access preserved; NO Subscription
   *                        row touched or created (PR2b approves into one).
   */
  scenario: "NEW_REQUEST" | "RENEWAL" | "LEGACY_GRANDFATHERED";
  /** Null exactly on the LEGACY_GRANDFATHERED path — no row exists or is made. */
  subscription: { id: string; status: string; planId: string } | null;
  payment: { id: string; status: string };
};

/**
 * One atomic unit of submission intent. Everything a submission may write is
 * here, in one transaction, so Payment + Subscription can never half-exist:
 *
 *   * entitlement resolution is read from the database, never from the body;
 *   * NEW / unentitled path: Subscription (singleton) → PENDING for the
 *     requested plan; NO Student.groupId write; NO batch reconciliation — the
 *     PR2b approval owns group assignment, capacity enforcement, batch
 *     reconciliation, date stacking and activation;
 *   * ACTIVE renewal path: Subscription untouched; a standalone PENDING
 *     Payment carries the intent;
 *   * LEGACY GRANDFATHERED path: no Subscription row exists or is created —
 *     a PENDING Payment (`subscriptionId = null`) records the intent, legacy
 *     access stays fully intact;
 *   * admin notification preserved from the pre-25 flow (same ANNOUNCEMENT
 *     fan-out), inside the transaction like today.
 */
export async function submitPaymentRequest(
  params: SubmitPaymentRequestParams
): Promise<SubmitPaymentRequestResult> {
  const { db, userId, studentId, groupId, plan, amount, notes, coupon } = params;
  const now = params.now ?? new Date();

  return db.$transaction(async (tx: any) => {
    // Read the CURRENT entitlement server-side (singleton subscription). The
    // group half of the grandfather rule needs the student's OWN group state —
    // read with the same shape the resolver uses (ACTIVE group bound to a
    // course); never trust the request body for entitlement, only for intent.
    const student = await tx.student.findUnique({
      where: { id: studentId },
      select: {
        groupId: true,
        group: { select: { isActive: true, courseId: true } },
        subscription: {
          select: { id: true, status: true, planId: true, endDate: true },
        },
      },
    });
    const currentSub = student?.subscription ?? null;
    const activeRenewal = isSubscriptionValidForAccess(currentSub, now);

    // GRANDFATHER VERDICT — taken from the central policy itself so the two
    // can never diverge: `grandfathered` is true exactly when
    // "group exists + ACTIVE + course-bound, and NO Subscription row".
    // (Reusing the pure function is the clean direction of dependency —
    // payment-submission already imports this module, so nothing cycles.)
    const decision = evaluateAccessDecision(
      {
        groupActive:
          !!student?.groupId &&
          student?.group?.isActive === true &&
          student?.group?.courseId != null,
        subscription: currentSub,
      },
      now
    );
    const legacyGrandfathered = decision.grandfathered;

    let subscription: { id: string; status: string; planId: string } | null = null;

    if (activeRenewal && currentSub) {
      // B. ACTIVE + unexpired renewal: preserve the entitlement UNCHANGED.
      // Do NOT downgrade ACTIVE → PENDING, do NOT touch planId/startDate/
      // endDate, do NOT move the student's group.
      subscription = {
        id: currentSub.id,
        status: String(currentSub.status),
        planId: currentSub.planId ?? plan.id,
      };
    } else if (legacyGrandfathered) {
      // C. LEGACY GRANDFATHERED (PR2a audit fix): this student's live
      // entitlement is grandfathered group access, and the policy makes any
      // Subscription row authoritative the moment it exists. Creating a
      // PENDING row here would therefore LOCK THEM OUT the instant they
      // submit — so no row is created or updated. The request lives on the
      // Payment alone (`subscriptionId = null`), and PR2b's approval creates
      // + activates the singleton. Access policy is untouched: this is a
      // submission-path fact, not a new access rule.
      subscription = null;
    } else {
      // A. New / unentitled student: the singleton Subscription becomes the
      // PENDING representation of the requested entitlement — created when
      // absent, UPDATED when a stale row exists (PENDING / EXPIRED /
      // CANCELLED / lazily-expired ACTIVE). Never a second row (singleton).
      if (currentSub) {
        subscription = await tx.subscription.update({
          where: { id: currentSub.id },
          data: { status: "PENDING", planId: plan.id },
          select: { id: true, status: true, planId: true },
        });
      } else {
        subscription = await tx.subscription.create({
          data: { studentId, planId: plan.id, status: "PENDING" },
          select: { id: true, status: true, planId: true },
        });
      }
    }

    // The request artifact — Payment carries its OWN intent so PR2b can
    // approve/reject without re-deriving (or mutating) current entitlement.
    // `subscriptionId` links the entitlement row when one exists; the legacy
    // grandfathered path has none to link — NULL is the honest value and is
    // schema-legal (nullable column since PR1; no migration).
    const payment = await tx.payment.create({
      data: {
        userId,
        subscriptionId: subscription?.id ?? null,
        amount,
        method: params.method,
        status: "PENDING",
        reference: params.reference,
        notes,
        senderPhone: params.senderPhone,
        requestedGroupId: groupId,
        requestedPlanId: plan.id,
      },
      select: { id: true, status: true },
    });

    // Coupon redemption keeps the pre-25 business rule: redeemed at
    // submission, tied to this payment (release-on-rejection is PR2b's).
    if (coupon) {
      await tx.couponRedemption.create({
        data: { couponId: coupon.id, userId, paymentId: payment.id },
      });
      await tx.coupon.update({
        where: { id: coupon.id },
        data: { usedCount: { increment: 1 } },
      });
    }

    // Admin review-queue notification (unchanged from the legacy flow).
    const admins = await tx.user.findMany({ where: { role: "ADMIN" } });
    if (admins.length > 0) {
      await tx.notification.createMany({
        data: admins.map((a: { id: string }) => ({
          userId: a.id,
          type: "ANNOUNCEMENT",
          title: params.notify.title,
          message: params.notify.message,
          link: params.notify.link,
        })),
      });
    }

    // CRITICAL (PR2a): no Student.groupId write, no batch mutation, no
    // subscription activation — PR2b owns those on approval. On the legacy
    // grandfathered path not even a Subscription row is manufactured.
    return {
      scenario: activeRenewal
        ? ("RENEWAL" as const)
        : legacyGrandfathered
          ? ("LEGACY_GRANDFATHERED" as const)
          : ("NEW_REQUEST" as const),
      subscription,
      payment,
    };
  });
}

// ---------------------------------------------------------------------------
// Student payment READ contract (PR3 renders this; PR2a guarantees truth).
// ---------------------------------------------------------------------------

/** Max rows a read returns — newest first, so PR2b's "latest request" rule
 *  is directly representable on the client without pagination games. */
export const PAYMENT_READ_LIMIT = 50;

const PAYMENT_SELECT = {
  id: true,
  status: true,
  amount: true,
  method: true,
  reference: true,
  senderPhone: true,
  requestedPlanId: true,
  requestedGroupId: true,
  rejectionReason: true,
  reviewedAt: true,
  createdAt: true,
} as const;

export type StudentPaymentRow = {
  id: string;
  status: string;
  amount: number;
  method: string;
  reference: string | null;
  senderPhone: string | null;
  requestedPlanId: string | null;
  requestedGroupId: string | null;
  /** Safe for the owner to see: admin-written free text, null when absent. */
  rejectionReason: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  /** Same-normalized-reference collision among the student's own rows. */
  duplicateReference: boolean;
  requestedPlan: { id: string; name: string; nameAr: string | null } | null;
  requestedGroup: { id: string; name: string; isActive: boolean } | null;
};

export type StudentPaymentsRead = {
  /** Newest first. Request history — entitlement lives in `entitlement`. */
  payments: StudentPaymentRow[];
  latestPending: StudentPaymentRow | null;
  latestRejected: StudentPaymentRow | null;
};

/**
 * Read the authenticated student's OWN payment history. Ownership is strict:
 * the caller passes the USER id resolved server-side from the session, and the
 * query is `where { userId }` — there is no parameter through which another
 * student's rows could be requested. Request fields are FK-less by design
 * (PR1), so plan/group display names are resolved defensively: an id pointing
 * at a deleted row reads `null`, never an error.
 */
export async function fetchStudentPayments(
  db: any,
  userId: string
): Promise<StudentPaymentsRead> {
  const rows = await db.payment.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAYMENT_READ_LIMIT,
    select: PAYMENT_SELECT,
  });

  const planIds = [...new Set(rows.map((r: { requestedPlanId: string | null }) => r.requestedPlanId).filter(Boolean))] as string[];
  const groupIds = [...new Set(rows.map((r: { requestedGroupId: string | null }) => r.requestedGroupId).filter(Boolean))] as string[];
  const [plans, groups] = await Promise.all([
    planIds.length
      ? db.subscriptionPlan.findMany({
          where: { id: { in: planIds } },
          select: { id: true, name: true, nameAr: true },
        })
      : Promise.resolve([]),
    groupIds.length
      ? db.group.findMany({
          where: { id: { in: groupIds } },
          select: { id: true, name: true, isActive: true },
        })
      : Promise.resolve([]),
  ]);
  const planById = new Map((plans as any[]).map((p) => [p.id, p]));
  const groupById = new Map((groups as any[]).map((g) => [g.id, g]));

  // Duplicate-reference warning: flagged, NEVER rejected (no unique
  // constraint exists or may exist — refs repeat across retries by design).
  const pendingKeyCounts = new Map<string, number>();
  for (const r of rows) {
    if (String(r.status).toUpperCase() !== "PENDING" || !r.reference) continue;
    const key = referenceComparisonKey(String(r.reference));
    pendingKeyCounts.set(key, (pendingKeyCounts.get(key) ?? 0) + 1);
  }

  const payments: StudentPaymentRow[] = rows.map((r: any) => {
    const dup =
      String(r.status).toUpperCase() === "PENDING" && !!r.reference
        ? (pendingKeyCounts.get(referenceComparisonKey(String(r.reference))) ?? 0) > 1
        : false;
    return {
      id: r.id,
      status: String(r.status),
      amount: r.amount,
      method: String(r.method),
      reference: r.reference ?? null,
      senderPhone: r.senderPhone ?? null,
      requestedPlanId: r.requestedPlanId ?? null,
      requestedGroupId: r.requestedGroupId ?? null,
      rejectionReason: typeof r.rejectionReason === "string" ? r.rejectionReason : null,
      reviewedAt: r.reviewedAt instanceof Date ? r.reviewedAt : r.reviewedAt ? new Date(r.reviewedAt) : null,
      createdAt: r.createdAt,
      duplicateReference: dup,
      requestedPlan: r.requestedPlanId
        ? planById.get(r.requestedPlanId) ?? null
        : null,
      requestedGroup: r.requestedGroupId
        ? groupById.get(r.requestedGroupId) ?? null
        : null,
    };
  });

  const statusOf = (p: StudentPaymentRow) => p.status.toUpperCase();
  const latestPending = payments.find((p) => statusOf(p) === "PENDING") ?? null;
  const latestRejected = payments.find((p) => statusOf(p) === "REJECTED") ?? null;
  return { payments, latestPending, latestRejected };
}
