// CodeMind Academy — Parent-facing subscription contract + status helper.
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

const NO_SUBSCRIPTION_TITLE = "ابنك لسه ما اشتركش في أي باقة.";
const NO_SUBSCRIPTION_MESSAGE =
  "الحساب شغال تمام وابنك مربوط بحسابك بنجاح، بس لسه ما اشتركش في أي باقة. لما ابنك يشترك في باقة، التقرير الشهري هيظهر هنا.";

export function describeParentSubscription(
  sub: ParentSubscriptionPayload | null | undefined
): ParentSubscriptionSummary {
  if (!sub) {
    return {
      state: "NONE",
      label: "Not subscribed",
      title: NO_SUBSCRIPTION_TITLE,
      message: NO_SUBSCRIPTION_MESSAGE,
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
          title: "الاشتراك شغال بس قرب يخلص.",
          message: `اشتراك ابنك بينتهي خلال ${Math.max(daysLeft, 0)} يوم — جدده علشان التقرير يفضل متاح.`,
          reportAvailable: true,
        };
      }
      return {
        state: "ACTIVE",
        label: "Active",
        title: "الاشتراك شغال.",
        message: daysLeft != null ? `فاضل ${daysLeft} يوم على انتهاء الاشتراك.` : "اشتراك ابنك نشط.",
        reportAvailable: true,
      };
    case "PENDING":
      return {
        state: "PENDING",
        label: "Pending",
        title: "الاشتراك لسه بيتراجع.",
        message: "ابنك قدّم طلب اشتراك ولسه مستني تأكيد الدفع من الإدارة.",
        reportAvailable: true,
      };
    case "EXPIRED":
      return {
        state: "EXPIRED",
        label: "Expired",
        title: "اشتراك ابنك انتهى.",
        message: "جدد الاشتراك علشان ابنك يكمل ويفضل التقرير الشهري متحدث.",
        reportAvailable: true,
      };
    case "CANCELLED":
      return {
        state: "CANCELLED",
        label: "Cancelled",
        title: "اشتراك ابنك اتلغى.",
        message: "لو حابب يكمل، ابنك يقدر يشترك في باقة جديدة من حسابه.",
        reportAvailable: true,
      };
    default:
      return {
        state: "UNKNOWN",
        label: String(sub.status || "—"),
        title: "حالة الاشتراك غير معروفة.",
        message: "تواصل مع الإدارة لو محتاج تفاصيل أكتر عن الاشتراك.",
        reportAvailable: true,
      };
  }
}
