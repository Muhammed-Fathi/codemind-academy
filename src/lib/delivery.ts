// CodeMind Academy — Outbound email delivery (Gmail SMTP).
//
// DESIGN RULE: this is deliberately NOT a fake integration. If SMTP is not
// configured, `sendEmail` returns `{ delivered: false, reason: "NOT_CONFIGURED" }`
// and never pretends a message was sent. In development you may set
// DELIVERY_DEV_LOG=1 to print a REDACTED delivery record (never the token or
// credentials) to the server log.
//
// Password recovery is EMAIL ONLY. There is intentionally no SMS/phone-based
// delivery here — phone numbers remain part of registration/profile data, but
// they are never used for password recovery.

import {
  sendMailViaSmtp,
  isSmtpConfigured,
  type MailSendResult,
} from "@/lib/mailer";

export type DeliveryResult = {
  delivered: boolean;
  provider: string;
  reason?: "NOT_CONFIGURED" | "PROVIDER_ERROR";
  /** Sanitized, credential-free diagnostic (never exposed to end users). */
  diagnosticError?: string;
};

function devLog(maskedTo: string) {
  if (process.env.DELIVERY_DEV_LOG === "1" && process.env.NODE_ENV !== "production") {
    // Deliberately logs no secret material — only that a message was queued.
    console.info(`[delivery] email message queued for ${maskedTo}`);
  }
}

function toDeliveryResult(result: MailSendResult): DeliveryResult {
  if (!result.ok) {
    return {
      delivered: false,
      provider: "gmail-smtp",
      reason: result.errorCode === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "PROVIDER_ERROR",
      diagnosticError: result.errorMessage || undefined,
    };
  }
  return { delivered: true, provider: "gmail-smtp" };
}

/**
 * Send a transactional email through Gmail SMTP (STARTTLS on port 587).
 *
 * Configure with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD (Gmail App
 * Password) and optionally EMAIL_FROM. Credentials live in the server
 * environment only and are never logged or returned.
 */
export async function sendEmail(params: {
  to: string;
  maskedTo: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<DeliveryResult> {
  const configured = isSmtpConfigured();
  if (!configured) {
    devLog(params.maskedTo);
    return { delivered: false, provider: "gmail-smtp", reason: "NOT_CONFIGURED" };
  }

  try {
    const result = await sendMailViaSmtp({
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
    if (!result.ok) return toDeliveryResult(result);
    devLog(params.maskedTo);
    return { delivered: true, provider: "gmail-smtp" };
  } catch {
    // sendMailViaSmtp already normalizes errors; this is a safety net.
    return { delivered: false, provider: "gmail-smtp", reason: "PROVIDER_ERROR" };
  }
}

/**
 * True when Gmail SMTP is usable in this environment. Callers may use this to
 * surface a health indicator server-side (never expose it to browsers).
 */
export function hasDeliveryProvider(): boolean {
  return isSmtpConfigured();
}
