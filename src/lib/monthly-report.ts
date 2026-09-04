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

export const NO_SUBSCRIPTION_STATUS_LABEL = "No active subscription";
export const NO_VALUE_PLACEHOLDER = "—";

/**
 * Normalizes the (possibly null) subscription payload into render-safe
 * labels for the Monthly Report subscription card.
 *
 * Regression fix: the report used to dereference `subscription.status`
 * unconditionally, crashing with "Cannot read properties of null" whenever
 * a student had no subscription. This mapping is total — null or partial
 * payloads always yield safe fallback labels instead of throwing.
 */
export function formatSubscriptionStatus(
  subscription: MonthlyReportSubscription
): {
  statusLabel: string;
  planName: string | null;
  daysLeftLabel: string;
} {
  if (!subscription) {
    return {
      statusLabel: NO_SUBSCRIPTION_STATUS_LABEL,
      planName: null,
      daysLeftLabel: NO_VALUE_PLACEHOLDER,
    };
  }
  return {
    statusLabel:
      subscription.status === "ACTIVE"
        ? "Active"
        : subscription.status || NO_SUBSCRIPTION_STATUS_LABEL,
    planName: subscription.planName || null,
    daysLeftLabel:
      subscription.daysLeft == null
        ? NO_VALUE_PLACEHOLDER
        : String(subscription.daysLeft),
  };
}
