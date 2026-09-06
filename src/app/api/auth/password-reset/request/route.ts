// POST /api/auth/password-reset/request
// Body: { identifier: string, channel?: "EMAIL" | "SMS" }
//
// Security properties:
//  * Always returns the SAME generic response → no account enumeration.
//  * Rate limited per identifier AND per client IP.
//  * Token/OTP is cryptographically random and only its SHA-256 is stored.
//  * Raw token/OTP is never logged and never returned in the response.
//  * Requesting a new token invalidates previous unused tokens for that user.

import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { ok, err } from "@/lib/api";
import {
  sha256,
  generateToken,
  generateOtp,
  hashIp,
  maskEmail,
  maskPhone,
  checkRateLimit,
  logSecurityEvent,
} from "@/lib/security";
import { sendEmail, sendSms } from "@/lib/delivery";
import { normalizePhone } from "@/lib/registration";
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

  const identifier = String(body.identifier || "").trim();
  const requestedChannel = body.channel === "SMS" ? "SMS" : "EMAIL";
  if (!identifier) return err(tApi("api.200"), 400);

  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const ipKey = hashIp(ip) || "unknown";
  const identifierKey = sha256(identifier.toLowerCase());

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

  // Look the user up by email OR phone (both are verified contact methods).
  const isEmail = identifier.includes("@");
  const user = isEmail
    ? await db.user.findUnique({
        where: { email: identifier.toLowerCase() },
        select: { id: true, email: true, phone: true },
      })
    : await db.user.findFirst({
        where: { phone: normalizePhone(identifier) },
        select: { id: true, email: true, phone: true },
      });

  if (!user) {
    await logSecurityEvent({
      type: "PASSWORD_RESET_REQUESTED",
      detail: "Unknown identifier (no account)",
      headers: hdrs,
    });
    return generic;
  }

  // Resolve the actual delivery channel from what the account really has.
  const channel = requestedChannel === "SMS" && user.phone ? "SMS" : "EMAIL";
  const destination = channel === "SMS" ? user.phone! : user.email;
  const destinationMask =
    channel === "SMS" ? maskPhone(destination) : maskEmail(destination);

  // Invalidate previous unused tokens — only one live token per user.
  await db.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  // EMAIL → long random token (link). SMS → 6-digit OTP.
  const secret = channel === "SMS" ? generateOtp(6) : generateToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000);

  await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: sha256(secret),
      channel,
      destinationMask,
      expiresAt,
    },
  });

  const appUrl = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";
  if (channel === "SMS") {
    await sendSms({
      to: destination,
      maskedTo: destinationMask,
      text: `CodeMind Academy: your password reset code is ${secret}. It expires in ${TOKEN_TTL_MIN} minutes. Never share it.`,
    });
  } else {
    const link = `${appUrl}/?reset=${encodeURIComponent(secret)}`;
    await sendEmail({
      to: destination,
      maskedTo: destinationMask,
      subject: "CodeMind Academy — Password reset",
      text: `Reset your password using this link (valid for ${TOKEN_TTL_MIN} minutes): ${link}\n\nIf you did not request this, ignore this email.`,
      html: `<p>Reset your password using this link (valid for ${TOKEN_TTL_MIN} minutes):</p><p><a href="${link}">Reset my password</a></p><p>If you did not request this, ignore this email.</p>`,
    });
  }

  // Audit trail contains only the MASKED destination — never the secret.
  await logSecurityEvent({
    userId: user.id,
    type: "PASSWORD_RESET_REQUESTED",
    detail: `channel=${channel} destination=${destinationMask}`,
    headers: hdrs,
  });

  return generic;
}
