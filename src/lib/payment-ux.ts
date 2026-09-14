// CodeMind Academy — Phase 25 PR3: the payment PRESENTATION layer.
//
// Pure + isomorphic (no React, no DB, no network). Everything here exists so
// the student payment page, the student payment panel and the admin review
// drawer render the SAME truthful facts about a manual (InstaPay / e& Cash)
// payment request — method labels, the per-method transfer destination, the
// WhatsApp proof numbers, the prefilled proof message and the review window.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//   * it makes NO access/entitlement decision — the single policy lives in
//     `src/lib/subscription-entitlement.ts` and the server applies it;
//   * it holds NO gateway/verification logic — the launch is manual transfer
//     + manual WhatsApp proof + admin decision (PR2b), nothing automatic;
//   * it never invents a payment destination: every destination value is READ
//     from the brand configuration for the SELECTED method
//     (`brand.payments.instapay` / `.eCash` / `.vodafoneCash`). There is no
//     generic fallback constant, so a method with no configured destination
//     renders as "not configured" instead of silently borrowing another
//     method's number;
//   * it never puts an internal identifier in a WhatsApp URL: the proof
//     message is built from the five user-facing facts only (name, amount,
//     method, transaction reference, sender phone). No `CM-XXXXXX` student
//     code, no userId / studentId / paymentId / subscriptionId.
//
// NO SCREENSHOT STORAGE: nothing here accepts, stores or uploads a proof
// image. The screenshot is attached manually by the student inside WhatsApp.

import { brand } from "@/lib/brand";

/**
 * How long a payment review may take. Surfaced in the student copy so the
 * text and the number can never drift apart. Never promise instant approval.
 */
export const PAYMENT_REVIEW_WINDOW_HOURS = 24;

// ---------------------------------------------------------------------------
// Payment methods — truthful user-facing labels
// ---------------------------------------------------------------------------

/**
 * Brand labels for the known `PaymentMethod` enum members. These are brand
 * names (identical in Arabic and English by product decision: the spec keeps
 * "InstaPay" / "e& Cash" as familiar English terms inside Arabic copy), so
 * they live here rather than in the translation dictionary.
 */
export const PAYMENT_METHOD_BRAND_LABELS: Record<string, string> = {
  INSTAPAY: "InstaPay",
  ETISALAT_CASH: "e& Cash",
  VODAFONE_CASH: "Vodafone Cash",
};

/**
 * Methods open at launch. Mirrors the server contract in
 * `src/lib/payment-submission.ts` (`SUPPORTED_PAYMENT_METHODS`) — the server
 * stays the authority; this copy exists only so the UI can mark the rest as
 * unavailable instead of offering a method the API refuses.
 */
export const LAUNCH_PAYMENT_METHODS: readonly string[] = [
  "INSTAPAY",
  "ETISALAT_CASH",
];

/** Normalize a raw enum/value for lookup (tolerant of case + whitespace). */
export function normalizePaymentMethod(method: unknown): string {
  return typeof method === "string" ? method.trim().toUpperCase() : "";
}

/**
 * Truthful label for ANY stored method value. Known members get their brand
 * label; anything else (a legacy import value, a future enum member) is
 * rendered as a readable form of the raw value — never an empty string, never
 * a fake brand.
 */
export function paymentMethodLabel(method: unknown): string {
  const key = normalizePaymentMethod(method);
  if (!key) return "";
  if (PAYMENT_METHOD_BRAND_LABELS[key]) return PAYMENT_METHOD_BRAND_LABELS[key];
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
    .join(" ");
}

/** Whether the launch supports this method for a NEW submission. */
export function isLaunchPaymentMethod(method: unknown): boolean {
  return LAUNCH_PAYMENT_METHODS.includes(normalizePaymentMethod(method));
}

/**
 * The transfer destination configured for ONE method, read from the brand
 * configuration. Returns `null` when that method has no configured
 * destination (e.g. Vodafone Cash) — callers render "not configured / contact
 * support" rather than substituting another method's number.
 *
 * NOTE (Phase 25 PR3 finding): `brand.payments.instapay` and
 * `brand.payments.eCash` are currently the SAME platform-wide line
 * (`+20 1147422177`, the support number) — that is the explicit configuration
 * in `src/lib/brand.ts`, not a UI decision. This function keeps the two reads
 * separate on purpose: when the business assigns a distinct e& Cash wallet
 * number it is a one-line configuration change and this UI follows it.
 */
export function paymentDestinationFor(method: unknown): string | null {
  const key = normalizePaymentMethod(method);
  switch (key) {
    case "INSTAPAY":
      return brand.payments.instapay || null;
    case "ETISALAT_CASH":
      return brand.payments.eCash || null;
    case "VODAFONE_CASH":
      return brand.payments.vodafoneCash || null;
    default:
      return null;
  }
}

/**
 * Whether a NEW payment request may be made with this method RIGHT NOW.
 *
 * A method is available only when BOTH hold:
 *   1. it is open for the manual launch (`LAUNCH_PAYMENT_METHODS`), and
 *   2. a non-empty transfer destination is configured for it.
 *
 * This is the single place that rule lives. The student method selector uses
 * it to render destination-less methods as disabled, and the form validation
 * uses it to refuse submission — so a method with no trusted destination can
 * never be chosen *or* submitted, even if component state somehow already
 * holds one (e.g. the configuration changed while the page was open).
 *
 * It never borrows another method's destination: an unconfigured method is
 * unavailable, full stop. Presentation-layer defense in depth only — the
 * server (`/api/enroll`) remains the authority.
 */
export function paymentMethodAvailable(method: unknown): boolean {
  if (!isLaunchPaymentMethod(method)) return false;
  const destination = paymentDestinationFor(method);
  return typeof destination === "string" && destination.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Money formatting with LATIN digits in both locales. Deliberately not
 * `ar-EG`: Arabic-Indic digits inside a transfer amount are easy to misread
 * when the student is typing the same number into a banking app. Matches the
 * existing admin ledger formatting.
 */
export function formatPaymentAmount(amount: unknown): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// WhatsApp proof (manual, external — no API, no auto-send, no attachment)
// ---------------------------------------------------------------------------

/**
 * The EXACT approved WhatsApp numbers for payment proof (local Egyptian
 * form). A student sends the screenshot to ONE of them — never both.
 *
 * `01147422177` is also the platform support line (`brand.SUPPORT_PHONE_DISPLAY`);
 * `01099942942` is the second approved proof line. Pinned by
 * `tests/payment-experience-phase25-pr3.test.js`.
 */
export const PAYMENT_PROOF_WHATSAPP_NUMBERS: readonly string[] = [
  "01147422177",
  "01099942942",
];

/**
 * Normalize an Egyptian number to the international digits WhatsApp expects
 * (`201XXXXXXXXX`). Accepts `01XXXXXXXXX`, `+20 1XXXXXXXXX`, `201XXXXXXXXX`
 * and spaced/dashed variants. Returns null when it is not a recognizable
 * Egyptian mobile number — the caller then does not render a link.
 */
export function normalizeEgyptianWhatsappNumber(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (/^01\d{9}$/.test(digits)) return `20${digits.slice(1)}`;
  if (/^201\d{9}$/.test(digits)) return digits;
  if (/^00201\d{9}$/.test(digits)) return digits.slice(2);
  return null;
}

/**
 * A safe, user-initiated `wa.me` deep link with a URL-encoded prefilled text.
 * No API integration, no auto-send: the student still attaches the screenshot
 * by hand inside WhatsApp.
 */
export function whatsappProofHref(
  number: string,
  message?: string | null
): string | null {
  const intl = normalizeEgyptianWhatsappNumber(number);
  if (!intl) return null;
  const text = typeof message === "string" && message.trim() ? message : "";
  return `https://wa.me/${intl}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** The five user-facing facts a proof message may carry. Nothing else. */
export type PaymentProofMessageFacts = {
  studentName?: string | null;
  amount?: number | string | null;
  method?: string | null;
  reference?: string | null;
  senderPhone?: string | null;
};

const safeText = (v: unknown): string => {
  const s = typeof v === "string" ? v.trim() : "";
  return s || "—";
};

/**
 * Build the prefilled WhatsApp proof text from the five approved facts.
 *
 * PRIVACY CONTRACT (pinned by tests): the message must never contain the
 * CodeMind student code (`CM-XXXXXX`) nor any internal identifier
 * (userId / studentId / paymentId / subscriptionId). The signature itself
 * makes that structural — only these five fields can reach the text.
 */
export function buildPaymentProofMessage(
  facts: PaymentProofMessageFacts,
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  return t("pay.proofMessage", {
    p1: safeText(facts.studentName),
    p2: safeText(
      facts.amount == null || facts.amount === ""
        ? ""
        : formatPaymentAmount(facts.amount)
    ),
    p3: safeText(facts.method ? paymentMethodLabel(facts.method) : ""),
    p4: safeText(facts.reference),
    p5: safeText(facts.senderPhone),
  });
}

// ---------------------------------------------------------------------------
// Request status presentation (labels only — the server owns the decision)
// ---------------------------------------------------------------------------

export type PaymentRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";

/** Normalize a stored payment status for label/tone lookup. */
export function normalizePaymentStatus(status: unknown): string {
  return typeof status === "string" ? status.trim().toUpperCase() : "";
}

/**
 * i18n key for a payment status label. Unknown values fall back to the raw
 * (upper-cased) status so a future enum member is still readable.
 */
export function paymentStatusTone(status: unknown): {
  key: string;
  tone: "pending" | "approved" | "rejected" | "muted";
} {
  switch (normalizePaymentStatus(status)) {
    case "PENDING":
      return { key: "pay.statusPending", tone: "pending" };
    case "APPROVED":
      return { key: "pay.statusApproved", tone: "approved" };
    case "REJECTED":
      return { key: "pay.statusRejected", tone: "rejected" };
    default:
      return { key: "pay.statusOther", tone: "muted" };
  }
}

// ---------------------------------------------------------------------------
// Admin decision errors — PR2b domain codes → clear UI copy + recovery hints
// ---------------------------------------------------------------------------

/**
 * Map of the PR2b decision-layer codes (plus the transport-level codes the
 * routes add: `DB_CONFLICT`, `INTERNAL`) to admin-facing i18n keys.
 *
 * The UI NEVER renders a raw database error: an unknown/absent code falls back
 * to `pay.errorGeneric`, and the server's own localized `error` message is only
 * ever used as a supplementary detail, never as the primary label.
 */
export const PAYMENT_DECISION_ERROR_KEYS: Record<string, string> = {
  PAYMENT_NOT_FOUND: "pay.paymentNotFound",
  INVALID_TRANSITION: "pay.errorInvalidTransition",
  STALE_PAYMENT: "pay.errorStale",
  NO_STUDENT: "pay.errorNoStudent",
  GROUP_REQUIRED: "pay.errorGroupRequired",
  GROUP_NOT_FOUND: "pay.errorGroupNotFound",
  GROUP_FULL: "pay.errorGroupFull",
  PLAN_REQUIRED: "pay.errorPlanRequired",
  PLAN_NOT_FOUND: "pay.errorPlanNotFound",
  INVALID_GROUP_CONTEXT: "pay.errorInvalidGroupContext",
  INVALID_REJECTION_REASON: "pay.errorInvalidRejectionReason",
  DB_CONFLICT: "pay.errorDbConflict",
  INTERNAL: "pay.errorInternal",
};

/** i18n key for a decision error code (safe fallback for unknown codes). */
export function paymentDecisionErrorKey(code: unknown): string {
  const key = typeof code === "string" ? code.trim().toUpperCase() : "";
  return PAYMENT_DECISION_ERROR_KEYS[key] ?? "pay.errorGeneric";
}

/**
 * Codes after which the admin queue/details MUST be re-read: the local row is
 * known to be out of date (another admin decided it, a newer request exists,
 * the row is gone, or a transient conflict rolled everything back).
 */
export const PAYMENT_DECISION_REFRESH_CODES: readonly string[] = [
  "INVALID_TRANSITION",
  "STALE_PAYMENT",
  "PAYMENT_NOT_FOUND",
  "DB_CONFLICT",
];

/**
 * Codes that mean "pick another group and try again" — the UI keeps the
 * payment visibly PENDING and offers the group override.
 */
export const PAYMENT_DECISION_GROUP_RECOVERY_CODES: readonly string[] = [
  "GROUP_REQUIRED",
  "GROUP_FULL",
  "GROUP_NOT_FOUND",
  "INVALID_GROUP_CONTEXT",
];

/**
 * Codes that CANNOT be fixed from the payment-review UI (no plan override
 * contract exists in PR3 by design — legacy plan repair is PR4 scope). The
 * payment stays PENDING and the admin is told so.
 */
export const PAYMENT_DECISION_PLAN_BLOCKED_CODES: readonly string[] = [
  "PLAN_REQUIRED",
  "PLAN_NOT_FOUND",
];

/** Must mirror the server: `REJECTION_REASON_MAX_LENGTH` in payment-transitions. */
export const REJECTION_REASON_MAX_LENGTH = 500;

/**
 * Normalize a rejection reason exactly the way the server does (trim + inner
 * whitespace collapse) so client validation and the API can never disagree.
 * Returns null when the reason is not acceptable.
 */
export function normalizeRejectionReasonForUi(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  if (collapsed.length > REJECTION_REASON_MAX_LENGTH) return null;
  return collapsed;
}
