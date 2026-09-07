// CodeMind Academy — Gmail SMTP transport (server-only).
//
// This module is the ONLY place that touches SMTP credentials. It must never
// be imported from a client component, and nothing it returns ever contains
// the username/password. Credentials are read from environment variables:
//
//   SMTP_HOST=smtp.gmail.com
//   SMTP_PORT=587
//   SMTP_USER=your-gmail-address
//   SMTP_PASSWORD=your-16-char-gmail-app-password
//   EMAIL_FROM=optional; defaults to SMTP_USER (Gmail requires the From
//              address to match the authenticated account)
//
// Port 587 uses STARTTLS (`secure:false` + `requireTLS:true`). For port 465
// (implicit TLS) set secure=true via SMTP_SECURE=1.

import nodemailer, { type Transporter } from "nodemailer";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
};

export type MailSendResult = {
  ok: boolean;
  messageId?: string;
  /** Short diagnostic for the operator; never contains credentials. */
  errorCode?: string | null;
  errorMessage?: string | null;
};

const GMAIL_HOST = "smtp.gmail.com";
const GMAIL_PORT = 587;

let cachedTransport: Transporter | null = null;
let cachedConfigKey = "";

/** True when the four required SMTP variables are present. */
export function isSmtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASSWORD
  );
}

/** Read the SMTP configuration from the environment. */
export function getSmtpConfig(): SmtpConfig | null {
  if (!isSmtpConfigured()) return null;

  const user = String(process.env.SMTP_USER);
  const port = Number(process.env.SMTP_PORT || GMAIL_PORT);
  return {
    host: String(process.env.SMTP_HOST || GMAIL_HOST),
    port: Number.isFinite(port) && port > 0 ? port : GMAIL_PORT,
    secure: process.env.SMTP_SECURE === "1" || port === 465,
    user,
    password: String(process.env.SMTP_PASSWORD),
    // Gmail requires the From address to be the authenticated address.
    from: String(process.env.EMAIL_FROM || user),
  };
}

/** Build (and cache) the nodemailer transport. */
export function getMailTransport(): Transporter | null {
  const config = getSmtpConfig();
  if (!config) return null;

  const key = `${config.host}:${config.port}:${config.secure}:${config.user}`;
  if (cachedTransport && cachedConfigKey === key) return cachedTransport;

  cachedTransport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure, // false → STARTTLS on 587 (upgraded via requireTLS)
    requireTLS: !config.secure, // never fall back to plaintext on 587
    auth: {
      user: config.user,
      pass: config.password,
    },
    // Gmail STARTTLS requires TLS >= 1.2.
    tls: { minVersion: "TLSv1.2" },
    // 20s connect timeout, 30s command timeout — fail fast on a dead network.
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
  cachedConfigKey = key;
  return cachedTransport;
}

/**
 * Strip anything that could look like a credential before surfacing an error.
 * The SMTP password must never reach logs or API responses.
 */
function sanitizeError(err: unknown): { code: string | null; message: string } {
  let raw = err instanceof Error ? err.message : String(err ?? "Unknown SMTP error");
  const config = getSmtpConfig();
  if (config) {
    raw = raw.split(config.password).join("[redacted]");
    raw = raw.split(config.user).join("[redacted]");
  }
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code ?? "").slice(0, 120) || null
      : null;
  return { code, message: raw.slice(0, 500) };
}

/** Send a plain-text / HTML email through the configured SMTP server. */
export async function sendMailViaSmtp(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<MailSendResult> {
  const transport = getMailTransport();
  if (!transport) {
    return { ok: false, errorCode: "NOT_CONFIGURED", errorMessage: "SMTP is not configured" };
  }
  const config = getSmtpConfig()!;

  try {
    const info = await transport.sendMail({
      from: config.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
    return { ok: true, messageId: info.messageId || undefined };
  } catch (err) {
    const { code, message } = sanitizeError(err);
    return { ok: false, errorCode: code, errorMessage: message };
  }
}

/** Safe transport diagnostics (no credentials) — used by the test script. */
export function smtpDiagnostics(): {
  configured: boolean;
  host?: string;
  port?: number;
  secure?: boolean;
  from?: string;
  userMasked?: string;
} {
  const config = getSmtpConfig();
  if (!config) return { configured: false };
  const user = config.user;
  const [local, domain] = user.split("@");
  return {
    configured: true,
    host: config.host,
    port: config.port,
    secure: config.secure,
    from: config.from,
    userMasked: domain
      ? `${local?.[0] ?? "*"}***@${domain}`
      : `${user.slice(0, 2)}***`,
  };
}

/** Verify credentials + STARTTLS without sending a message. */
export async function verifySmtpConnection(): Promise<MailSendResult> {
  const transport = getMailTransport();
  if (!transport) {
    return { ok: false, errorCode: "NOT_CONFIGURED", errorMessage: "SMTP is not configured" };
  }
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    const { code, message } = sanitizeError(err);
    return { ok: false, errorCode: code, errorMessage: message };
  }
}
