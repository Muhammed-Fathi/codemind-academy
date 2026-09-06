// CodeMind Academy — Outbound email / SMS delivery abstraction.
//
// The repository had no provider abstraction, so this module introduces one.
//
// DESIGN RULE: this is deliberately NOT a fake integration. If no provider is
// configured, `send*` returns `{ delivered: false, reason: "NOT_CONFIGURED" }`
// and the caller treats the request as un-deliverable. It never pretends a
// message was sent. In development you may set DELIVERY_DEV_LOG=1 to print a
// REDACTED delivery record (never the token/OTP itself) to the server log.

export type DeliveryResult = {
  delivered: boolean;
  provider: string;
  reason?: "NOT_CONFIGURED" | "PROVIDER_ERROR";
};

function devLog(channel: string, maskedTo: string) {
  if (process.env.DELIVERY_DEV_LOG === "1" && process.env.NODE_ENV !== "production") {
    // Deliberately logs no secret material — only that a message was queued.
    console.info(`[delivery] ${channel} message queued for ${maskedTo}`);
  }
}

/**
 * Send a transactional email through the configured SMTP/HTTP provider.
 * Configure with EMAIL_PROVIDER + EMAIL_API_KEY + EMAIL_FROM.
 */
export async function sendEmail(params: {
  to: string;
  maskedTo: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<DeliveryResult> {
  const provider = process.env.EMAIL_PROVIDER;
  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!provider || !apiKey || !from) {
    devLog("email", params.maskedTo);
    return { delivered: false, provider: "none", reason: "NOT_CONFIGURED" };
  }

  try {
    if (provider === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [params.to],
          subject: params.subject,
          text: params.text,
          html: params.html,
        }),
      });
      if (!res.ok) return { delivered: false, provider, reason: "PROVIDER_ERROR" };
      devLog("email", params.maskedTo);
      return { delivered: true, provider };
    }

    // Unknown provider name — treat as not configured rather than guessing.
    return { delivered: false, provider, reason: "NOT_CONFIGURED" };
  } catch {
    return { delivered: false, provider, reason: "PROVIDER_ERROR" };
  }
}

/**
 * Send a transactional SMS. Configure with SMS_PROVIDER + SMS_API_KEY +
 * SMS_SENDER (and SMS_API_SECRET for providers that need it).
 */
export async function sendSms(params: {
  to: string;
  maskedTo: string;
  text: string;
}): Promise<DeliveryResult> {
  const provider = process.env.SMS_PROVIDER;
  const apiKey = process.env.SMS_API_KEY;
  const sender = process.env.SMS_SENDER;

  if (!provider || !apiKey || !sender) {
    devLog("sms", params.maskedTo);
    return { delivered: false, provider: "none", reason: "NOT_CONFIGURED" };
  }

  try {
    if (provider === "twilio") {
      const sid = process.env.SMS_ACCOUNT_SID || "";
      const secret = process.env.SMS_API_SECRET || "";
      const body = new URLSearchParams({
        To: params.to,
        From: sender,
        Body: params.text,
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization:
              "Basic " + Buffer.from(`${apiKey}:${secret}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        }
      );
      if (!res.ok) return { delivered: false, provider, reason: "PROVIDER_ERROR" };
      devLog("sms", params.maskedTo);
      return { delivered: true, provider };
    }

    return { delivered: false, provider, reason: "NOT_CONFIGURED" };
  } catch {
    return { delivered: false, provider, reason: "PROVIDER_ERROR" };
  }
}

/** True when at least one reset channel is usable in this environment. */
export function hasDeliveryProvider(): boolean {
  return Boolean(
    (process.env.EMAIL_PROVIDER && process.env.EMAIL_API_KEY && process.env.EMAIL_FROM) ||
      (process.env.SMS_PROVIDER && process.env.SMS_API_KEY && process.env.SMS_SENDER)
  );
}
