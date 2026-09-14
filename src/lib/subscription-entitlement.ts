// CodeMind Academy — Phase 25 PR2a: the ONE subscription-entitlement policy.
//
// THE BUSINESS MODEL (Phase 25 source of truth)
//   Subscription = the current student ENTITLEMENT.
//   Payment      = an individual payment request / payment attempt.
//   Student.groupId = the currently active course/group assignment.
//   A PENDING payment request is NOT an entitlement.
//
// REQUIRED ACCESS STATES (paid course content)
//   PENDING   = NO paid course access
//   APPROVED  = access only through a valid ACTIVE entitlement (the Payment
//               being APPROVED never opens content by itself — the
//               Subscription row does)
//   REJECTED  = NO access from that request
//   EXPIRED   = NO paid course access
//   CANCELLED = NO paid course access
//   Subscription ACTIVE + endDate in the past = NO access. Expiry is enforced
//   LAZILY here: the stored status is never rewritten just because someone
//   opened a page, and no cron participates.
//
// LEGACY GRANDFATHERING
//   Students who exist with a valid group assignment but NO Subscription row
//   keep their pre-Phase-25 access. A Subscription row, once it exists, is
//   authoritative — including the students it locks out (PENDING / CANCELLED
//   / expired). Authorization NEVER creates a Subscription as a side effect.
//
// THIS MODULE IS THE ONLY HOME OF THAT RULE. `getEnrollment`, `canAccessLesson`
// and the batch unlock gate (`getUnlockedLessonIds`) all consult it so every
// downstream surface (courses, lessons, materials, quizzes, videos, homework,
// progress, dashboard) inherits one consistent policy instead of many slightly
// different copies. It is side-effect free on every path, including the async
// resolver: reads only, no writes, no lazy state transitions.
//
// Dual-engine safe by construction: pure comparisons over `Date` values that
// Prisma already materializes from the database (SQLite DATETIME text / PG
// timestamptz). Nothing here parses locale strings; `toDate` accepts only Date,
// epoch numbers and ISO-8601 UTC (the shapes Prisma and JSON round-trip), and
// an unparseable NON-NULL date FAILS CLOSED (treated as expired) — a missing
// `endDate` is the only "no expiry recorded" state, matching the column being
// nullable by design (PENDING subs carry no dates until approval).

export const EXPIRING_WINDOW_DAYS = 7;

/** Structural mirror of the fields the policy reads (never import the client). */
export type SubscriptionAccessRow = {
  status: unknown;
  startDate?: unknown;
  endDate?: unknown;
  plan?: { id?: string; name?: string | null; nameAr?: string | null } | null;
} | null | undefined;

export type AccessDecisionReason =
  | "OK_ACTIVE"
  | "OK_GRANDFATHERED"
  | "NO_GROUP"
  | "SUBSCRIPTION_PENDING"
  | "SUBSCRIPTION_NOT_ACTIVE"
  | "SUBSCRIPTION_EXPIRED";

export type AccessDecision = {
  /** The single answer every authorization path must agree on. */
  allowed: boolean;
  /** True for a grouped student with NO Subscription row (legacy access). */
  grandfathered: boolean;
  /** True when a Subscription row exists (it is then authoritative). */
  hasSubscription: boolean;
  reason: AccessDecisionReason;
};

/**
 * Coerce a stored date to `Date | null` WITHOUT locale parsing.
 * `null`  → "no expiry recorded"; `INVALID` → caller fails closed.
 */
function toDate(value: unknown): { date: Date | null; invalid: boolean } {
  if (value == null) return { date: null, invalid: false };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { date: null, invalid: true }
      : { date: value, invalid: false };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? { date: null, invalid: true } : { date: d, invalid: false };
  }
  if (typeof value === "string") {
    const s = value.trim();
    // Only ISO-8601-shaped strings: never locale dates.
    if (/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(s)) {
      const d = new Date(s.includes("T") && !/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? `${s}Z` : s);
      return Number.isNaN(d.getTime()) ? { date: null, invalid: true } : { date: d, invalid: false };
    }
    return { date: null, invalid: true };
  }
  return { date: null, invalid: true };
}

/**
 * Is this stored Subscription row itself a VALID entitlement right now?
 *
 *   - row missing            -> false (the grandfathering decision is the
 *                               CALLER's — it belongs to the student/group,
 *                               not to the subscription, so it never lives here)
 *   - status not ACTIVE      -> false (PENDING / EXPIRED / CANCELLED / unknown)
 *   - ACTIVE, no endDate     -> true  (no expiry recorded; approval always
 *                               writes one, this only covers anomalous rows)
 *   - ACTIVE, endDate future -> true
 *   - ACTIVE, endDate in the past (or unparseable) -> FALSE — the lazy expiry
 *       rule: a stored ACTIVE row with a past endDate is expired for access
 *       even though nothing has written EXPIRED yet.
 */
export function isSubscriptionValidForAccess(
  subscription: SubscriptionAccessRow,
  now: Date = new Date()
): boolean {
  if (!subscription) return false;
  if (String(subscription.status ?? "").toUpperCase() !== "ACTIVE") return false;
  const { date, invalid } = toDate(subscription.endDate);
  if (invalid) return false; // fail closed on garbage
  if (date === null) return true; // ACTIVE without an endDate: not expired
  return date.getTime() > now.getTime();
}

/**
 * THE decision every authorization path shares.
 *
 * `groupActive` must mean exactly "member of an ACTIVE group bound to the
 * course under consideration" — each caller computes that with the shape it
 * already has (getEnrollment: `group.isActive && group.course`;
 * canAccessLesson: `group.isActive && group.courseId === lessonCourseId`).
 * Passing a looser flag weakens the enrollment half of the rule; the
 * subscription half is decided here, once.
 */
export function evaluateAccessDecision(
  input: { groupActive: boolean; subscription: SubscriptionAccessRow },
  now: Date = new Date()
): AccessDecision {
  const hasSubscription = input.subscription != null;
  if (!input.groupActive) {
    return { allowed: false, grandfathered: false, hasSubscription, reason: "NO_GROUP" };
  }
  if (!hasSubscription) {
    // Legacy grandfathering: grouped student, no Subscription row at all.
    return { allowed: true, grandfathered: true, hasSubscription: false, reason: "OK_GRANDFATHERED" };
  }
  if (isSubscriptionValidForAccess(input.subscription, now)) {
    return { allowed: true, grandfathered: false, hasSubscription: true, reason: "OK_ACTIVE" };
  }
  const status = String(input.subscription?.status ?? "").toUpperCase();
  if (status === "PENDING") {
    return { allowed: false, grandfathered: false, hasSubscription: true, reason: "SUBSCRIPTION_PENDING" };
  }
  const { date, invalid } = toDate(input.subscription?.endDate);
  if (status === "ACTIVE" && (invalid || (date !== null && date.getTime() <= now.getTime()))) {
    return { allowed: false, grandfathered: false, hasSubscription: true, reason: "SUBSCRIPTION_EXPIRED" };
  }
  return { allowed: false, grandfathered: false, hasSubscription: true, reason: "SUBSCRIPTION_NOT_ACTIVE" };
}

export type SubscriptionReadState =
  | "ACTIVE"
  | "EXPIRING"
  | "PENDING"
  | "EXPIRED"
  | "CANCELLED"
  | "NONE";

export type SubscriptionStateInfo = {
  /**
   * UI-TRUTH label for the CURRENT entitlement — never "Active" for a PENDING
   * request. `EXPIRING` is an ACTIVE, unexpired subscription within
   * `EXPIRING_WINDOW_DAYS`; `EXPIRED` covers both a stored EXPIRED row and a
   * lazily expired ACTIVE one (the Phase 25 honesty rule).
   */
  state: SubscriptionReadState;
  /** Days until endDate (rounded up); 0 when there is no endDate. */
  daysToExpiry: number;
  /** Raw stored enum value for consumers that must not lose information. */
  rawStatus: string | null;
  endDate: Date | null;
  startDate: Date | null;
};

/** Read-model labeling for dashboards/me routes. Pure, no I/O. */
export function describeSubscriptionState(
  subscription: SubscriptionAccessRow,
  now: Date = new Date()
): SubscriptionStateInfo {
  if (!subscription) {
    return { state: "NONE", daysToExpiry: 0, rawStatus: null, endDate: null, startDate: null };
  }
  const status = String(subscription.status ?? "").toUpperCase();
  const start = toDate(subscription.startDate).date;
  const endRes = toDate(subscription.endDate);
  const end = endRes.invalid ? null : endRes.date;
  if (status === "PENDING") {
    return { state: "PENDING", daysToExpiry: 0, rawStatus: status, endDate: end, startDate: start };
  }
  if (status === "CANCELLED") {
    return { state: "CANCELLED", daysToExpiry: 0, rawStatus: status, endDate: end, startDate: start };
  }
  if (status === "ACTIVE") {
    if (endRes.invalid || (end !== null && end.getTime() <= now.getTime())) {
      return { state: "EXPIRED", daysToExpiry: 0, rawStatus: status, endDate: end, startDate: start };
    }
    const days = end === null ? 0 : Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    const state: SubscriptionReadState =
      end !== null && days <= EXPIRING_WINDOW_DAYS ? "EXPIRING" : "ACTIVE";
    return { state, daysToExpiry: days, rawStatus: status, endDate: end, startDate: start };
  }
  // EXPIRED or an unknown status: the entitlement is not live.
  return {
    state: status === "EXPIRED" ? "EXPIRED" : "CANCELLED",
    daysToExpiry: 0,
    rawStatus: status || null,
    endDate: end,
    startDate: start,
  };
}

// ---------------------------------------------------------------------------
// The single async resolver for STUDENT-FACING READ SURFACES
// (student dashboard, /api/students/me/payments, the enrollment V2 response).
// Authorization hot paths (getEnrollment / canAccessLesson) reuse the PURE
// helpers above against rows they already loaded — one policy, no extra reads.
// READS ONLY — this resolver never creates or mutates anything.
// ---------------------------------------------------------------------------

import { db as defaultDb } from "@/lib/db";

export type StudentEntitlementSnapshot = {
  studentId: string;
  /** Student currently attached to a group at all. */
  hasGroup: boolean;
  /** That group is ACTIVE and bound to a course (the enrollment half). */
  groupActive: boolean;
  groupId: string | null;
  groupName: string | null;
  courseId: string | null;
  /** Raw Subscription.status, or null when the student has no row. */
  subscriptionStatus: string | null;
  /** True iff a Subscription row exists (then it is authoritative). */
  hasSubscription: boolean;
  /** The ONE entitlement answer, straight from `evaluateAccessDecision`. */
  accessAllowed: boolean;
  /** Legacy grandfathered access (group, no Subscription row). */
  grandfathered: true | false;
  /** UI-truth label for the current entitlement (never "Active" for PENDING). */
  state: SubscriptionReadState;
  daysToExpiry: number;
  startDate: Date | null;
  endDate: Date | null;
  plan: { id: string; name: string; nameAr: string | null } | null;
};

/**
 * Resolve the CURRENT entitlement of one student. Distinct from a PENDING
 * Payment request on purpose: `subscriptionStatus`/`state` describe the
 * entitlement, while a pending request is surfaced separately by the payment
 * read API. A pending request must never look like an active entitlement.
 */
export async function resolveStudentEntitlement(
  studentId: string,
  options?: { now?: Date; db?: typeof defaultDb }
): Promise<StudentEntitlementSnapshot | null> {
  const client = options?.db ?? defaultDb;
  const now = options?.now ?? new Date();
  const student = await client.student.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      groupId: true,
      group: {
        select: {
          id: true,
          name: true,
          isActive: true,
          courseId: true,
        },
      },
      subscription: {
        select: {
          status: true,
          startDate: true,
          endDate: true,
          plan: { select: { id: true, name: true, nameAr: true } },
        },
      },
    },
  });
  if (!student) return null;

  const groupActive = !!student.group?.isActive && !!student.group?.courseId;
  const decision = evaluateAccessDecision(
    { groupActive, subscription: student.subscription },
    now
  );
  const described = describeSubscriptionState(student.subscription, now);
  return {
    studentId: student.id,
    hasGroup: !!student.groupId,
    groupActive,
    groupId: student.group?.id ?? null,
    groupName: student.group?.name ?? null,
    courseId: student.group?.courseId ?? null,
    subscriptionStatus:
      student.subscription == null
        ? null
        : String(student.subscription.status ?? "").toUpperCase() || null,
    hasSubscription: student.subscription != null,
    accessAllowed: decision.allowed,
    grandfathered: decision.grandfathered,
    state: described.state,
    daysToExpiry: described.daysToExpiry,
    startDate: described.startDate,
    endDate: described.endDate,
    plan: student.subscription?.plan
      ? {
          id: student.subscription.plan.id,
          name: student.subscription.plan.name,
          nameAr: student.subscription.plan.nameAr ?? null,
        }
      : null,
  };
}
