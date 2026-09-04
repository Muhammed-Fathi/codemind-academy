// CodeMind Academy — Parent-facing subscription contract + status helper.

import { translate, type Locale } from "@/lib/i18n-core";
//
// Single source of truth for the `subscription` field returned per child by
// GET /api/parents/me/dashboard and consumed by the Parent Dashboard and the
// Monthly Report. A student who registered but never enrolled (POST
// /api/enroll) has NO Subscription row, so `null` is a valid, expected value.

/** Mirrors `enum SubscriptionStatus` in prisma/schema.prisma. */
export type SubscriptionStatus = "PENDING" | "ACTIVE" | "EXPIRED" | "CANCELLED";

export type ParentSubscriptionPayload = {
  status: SubscriptionStatus | string;
  planName: string;
  startDate: string | Date | null;
  endDate: string | Date | null;
  /** Days until endDate; null when the subscription has no endDate yet. */
  daysLeft: number | null;
  price: number;
  durationMonths: number;
};

export type ParentSubscriptionState =
  | "NONE"
  | "ACTIVE"
  | "EXPIRING"
  | "PENDING"
  | "EXPIRED"
  | "CANCELLED"
  | "UNKNOWN";

export type ParentSubscriptionSummary = {
  state: ParentSubscriptionState;
  /** Short English badge label (matches the dashboard SubscriptionCard). */
  label: string;
  /** Short Egyptian Arabic headline. */
  title: string;
  /** Egyptian Arabic explanation for the parent. */
  message: string;
  /**
   * Whether the Monthly Report body should be rendered. The existing app does
   * not gate reports on an ACTIVE subscription; only a student with no
   * subscription at all (never enrolled) has nothing to report.
   */
  reportAvailable: boolean;
};

export function describeParentSubscription(
  sub: ParentSubscriptionPayload | null | undefined,
  locale: Locale = "ar"
): ParentSubscriptionSummary {
  const t = (key: string, params?: Record<string, unknown>) =>
    translate(locale, key, params);
  if (!sub) {
    return {
      state: "NONE",
      label: "Not subscribed",
      title: t("lib.001"),
      message: t("lib.002"),
      reportAvailable: false,
    };
  }

  const daysLeft = sub.daysLeft;
  switch (sub.status) {
    case "ACTIVE":
      if (daysLeft != null && daysLeft <= 7) {
        return {
          state: "EXPIRING",
          label: "Expiring",
          title: t("lib.003"),
          message: t("lib.004", { p1: Math.max(daysLeft, 0) }),
          reportAvailable: true,
        };
      }
      return {
        state: "ACTIVE",
        label: "Active",
        title: t("lib.005"),
        message: daysLeft != null ? t("lib.006", { p1: daysLeft }) : t("lib.007"),
        reportAvailable: true,
      };
    case "PENDING":
      return {
        state: "PENDING",
        label: "Pending",
        title: t("lib.008"),
        message: t("lib.009"),
        reportAvailable: true,
      };
    case "EXPIRED":
      return {
        state: "EXPIRED",
        label: "Expired",
        title: t("lib.010"),
        message: t("lib.011"),
        reportAvailable: true,
      };
    case "CANCELLED":
      return {
        state: "CANCELLED",
        label: "Cancelled",
        title: t("lib.012"),
        message: t("lib.013"),
        reportAvailable: true,
      };
    default:
      return {
        state: "UNKNOWN",
        label: String(sub.status || "—"),
        title: t("lib.014"),
        message: t("lib.015"),
        reportAvailable: true,
      };
  }
}
