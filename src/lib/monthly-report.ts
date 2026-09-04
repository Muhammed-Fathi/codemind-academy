// CodeMind Academy — Monthly Report helpers.
// Framework-free logic shared by the parent-facing Monthly Report view so it
// can be unit-tested offline (see tests/monthly-report-no-subscription.test.js).

/**
 * The subscription payload shipped to the Monthly Report, as produced by
 * GET /api/parents/me/dashboard (`subscriptionPayload`). It is `null`
 * whenever the student has no Subscription row, and `daysLeft` is `null`
 * when the subscription has no endDate.
 */
export type MonthlyReportSubscription = {
  status: string;
  planName: string;
  daysLeft: number | null;
} | null;

/** No-subscription empty state (natural Egyptian Arabic, like the app copy). */
export const NO_SUBSCRIPTION_STATUS_LABEL = "ابنك لسه ما اشتركش في أي باقة.";
export const NO_SUBSCRIPTION_HINT =
  "لما ابنك يشترك في باقة، هتظهر تفاصيل الباقة هنا في التقرير الشهري.";
export const NO_VALUE_PLACEHOLDER = "—";

/**
 * User-facing Egyptian Arabic labels for the SubscriptionStatus enum
 * (PENDING / ACTIVE / EXPIRED / CANCELLED in prisma/schema.prisma).
 * Raw enum values must never reach the parent-facing report.
 */
export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "نشط",
  PENDING: "مستني التفعيل",
  EXPIRED: "منتهي",
  CANCELLED: "ملغي",
};

/**
 * Normalizes the (possibly null) subscription payload into render-safe,
 * localized labels for the Monthly Report subscription card.
 *
 * Regression fix: the report used to dereference `subscription.status`
 * unconditionally, crashing with "Cannot read properties of null" whenever
 * a student had no subscription. This mapping is total — null or partial
 * payloads always yield safe fallback labels instead of throwing.
 *
 * Display-only: it reads the payload as-is and changes no business logic.
 */
export function formatSubscriptionStatus(
  subscription: MonthlyReportSubscription
): {
  statusLabel: string;
  planName: string | null;
  daysLeftLabel: string;
  noSubscription: boolean;
  hint: string | null;
} {
  if (!subscription) {
    return {
      statusLabel: NO_SUBSCRIPTION_STATUS_LABEL,
      planName: null,
      daysLeftLabel: NO_VALUE_PLACEHOLDER,
      noSubscription: true,
      hint: NO_SUBSCRIPTION_HINT,
    };
  }
  return {
    statusLabel:
      SUBSCRIPTION_STATUS_LABELS[subscription.status] ?? subscription.status,
    planName:
      subscription.planName && subscription.planName !== NO_VALUE_PLACEHOLDER
        ? subscription.planName
        : null,
    daysLeftLabel:
      subscription.daysLeft == null
        ? NO_VALUE_PLACEHOLDER
        : String(subscription.daysLeft),
    noSubscription: false,
    hint: null,
  };
}
