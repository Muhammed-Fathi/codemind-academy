// POST /api/auth/password-reset/request
// Body: { email: string }
//
// Password recovery is EMAIL ONLY — phone numbers are never used for account
// recovery, and no SMS/OTP code is generated.
//
// Security properties:
//  * Always returns the SAME generic response → no account enumeration.
//  * Rate limited per email AND per client IP.
//  * Token is cryptographically random and only its SHA-256 is stored.
//  * Raw token is never logged and never returned in the response.
//  * Requesting a new token invalidates previous unused tokens for that user.
//  * A delivery failure is never surfaced to the caller (it could leak the
//    existence of an account); diagnostics are audit-logged server-side.

import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { ok, err } from "@/lib/api";
import {
  sha256,
  generateToken,
  hashIp,
  maskEmail,
  checkRateLimit,
  logSecurityEvent,
} from "@/lib/security";
import { sendEmail } from "@/lib/delivery";
import { isValidEmail } from "@/lib/registration";
import { getServerT } from "@/lib/i18n-server";

const TOKEN_TTL_MIN = Number(process.env.PASSWORD_RESET_TTL_MINUTES || 15);
const PER_IDENTIFIER_LIMIT = 3;
const PER_IDENTIFIER_WINDOW_SEC = 15 * 60;
const PER_IP_LIMIT = 10;
const PER_IP_WINDOW_SEC = 60 * 60;

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const hdrs = await headers();
  const body = await req.json().catch(() => ({}));

  // `email` is the canonical field; `identifier` is accepted only for
  // backward compatibility with old clients. Either way it must be an email.
  const email = String(body.email || body.identifier || "").trim().toLowerCase();
  if (!email) return err(tApi("api.200"), 400);
  if (!isValidEmail(email)) return err(tApi("api.220"), 400);

  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const ipKey = hashIp(ip) || "unknown";
  const identifierKey = sha256(email);

  // Generic response used for EVERY outcome (found / not found / rate-limited
  // per identifier), so the client cannot probe which accounts exist.
  const generic = ok({
    ok: true,
    message: tApi("api.201"),
    expiresInMinutes: TOKEN_TTL_MIN,
  });

  const ipLimit = await checkRateLimit(
    "pwreset:ip",
    ipKey,
    PER_IP_LIMIT,
    PER_IP_WINDOW_SEC
  );
  if (!ipLimit.allowed) {
    await logSecurityEvent({
      type: "PASSWORD_RESET_FAILED",
      detail: "IP rate limit exceeded",
      headers: hdrs,
    });
    return err(tApi("api.202"), 429);
  }

  const idLimit = await checkRateLimit(
    "pwreset:id",
    identifierKey,
    PER_IDENTIFIER_LIMIT,
    PER_IDENTIFIER_WINDOW_SEC
  );
  // Silently succeed: revealing the limit per-identifier would leak existence.
  if (!idLimit.allowed) return generic;

  // Email is the only recovery identifier.
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });

  // Keep this exact detail string: source-level tests assert that a missing
  // account still follows the generic path.
  if (!user) {
    await logSecurityEvent({
      type: "PASSWORD_RESET_REQUESTED",
      detail: "Unknown identifier (no account)",
      headers: hdrs,
    });
    return generic;
  }

  const destination = user.email;
  const destinationMask = maskEmail(destination);

  // Invalidate previous unused tokens — only one live token per user.
  await db.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  // High-entropy link token (no OTP — recovery is email-only).
  const secret = generateToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000);

  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(secret),
      channel: "EMAIL",
      destinationMask,
      expiresAt,
    },
  });

  const appUrl = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";
  const link = `${appUrl}/?token=${encodeURIComponent(secret)}`;

  const delivery = await sendEmail({
    to: destination,
    maskedTo: destinationMask,
    subject: "CodeMind Academy — Password reset",
    text: `Reset your password using this secure link (valid for ${TOKEN_TTL_MIN} minutes): ${link}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Reset your password using this secure link (valid for ${TOKEN_TTL_MIN} minutes):</p><p><a href="${link}">Reset my password</a></p><p>If you did not request this, ignore this email.</p>`,
  });

  // Audit trail contains only the MASKED destination and delivery outcome —
  // never the secret, never SMTP credentials or raw provider errors.
  await logSecurityEvent({
    userId: user.id,
    type: "PASSWORD_RESET_REQUESTED",
    detail: `channel=EMAIL destination=${destinationMask} delivered=${delivery.delivered}`,
    headers: hdrs,
  });

  // Never reveal whether delivery succeeded: this response is identical for
  // every valid request.
  return generic;
}
