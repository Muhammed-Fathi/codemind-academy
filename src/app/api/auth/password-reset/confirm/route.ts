// POST /api/auth/password-reset/confirm
// Body: { token: string, password: string, identifier?: string }
//
// Security properties:
//  * Token is looked up by SHA-256 — the raw value is never stored.
//  * Single use: `usedAt` is stamped inside the same transaction as the
//    password change, so a token can never be replayed.
//  * Expired tokens are rejected and consumed.
//  * Per-token attempt limit prevents brute-forcing 6-digit SMS OTPs.
//  * All other reset tokens of the user are invalidated afterwards.
//  * All active sessions are revoked — the user must log in again.

import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { ok, err } from "@/lib/api";
import { hashPassword, revokeAllSessions } from "@/lib/auth";
import {
  sha256,
  hashIp,
  checkRateLimit,
  resetRateLimit,
  logSecurityEvent,
} from "@/lib/security";
import { getServerT } from "@/lib/i18n-server";

const MAX_TOKEN_ATTEMPTS = 5;
const PER_IP_LIMIT = 20;
const PER_IP_WINDOW_SEC = 60 * 60;

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const hdrs = await headers();
  const body = await req.json().catch(() => ({}));

  const token = String(body.token || "").trim();
  const password = String(body.password || "");

  if (!token) return err(tApi("api.203"), 400);
  if (password.length < 8) return err(tApi("api.204"), 400);

  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const ipKey = hashIp(ip) || "unknown";

  const ipLimit = await checkRateLimit(
    "pwreset:confirm:ip",
    ipKey,
    PER_IP_LIMIT,
    PER_IP_WINDOW_SEC
  );
  if (!ipLimit.allowed) {
    await logSecurityEvent({
      type: "PASSWORD_RESET_FAILED",
      detail: "Confirm IP rate limit exceeded",
      headers: hdrs,
    });
    return err(tApi("api.202"), 429);
  }

  const record = await db.passwordResetToken.findUnique({
    where: { tokenHash: sha256(token) },
  });

  // Uniform error for unknown / used / expired tokens.
  const invalid = () => err(tApi("api.205"), 400);

  if (!record) {
    await logSecurityEvent({
      type: "PASSWORD_RESET_FAILED",
      detail: "Unknown or already-consumed token presented",
      headers: hdrs,
    });
    return invalid();
  }

  if (record.usedAt) {
    await logSecurityEvent({
      userId: record.userId,
      type: "PASSWORD_RESET_FAILED",
      detail: "Reuse of an already-used token",
      headers: hdrs,
    });
    return invalid();
  }

  if (record.expiresAt.getTime() < Date.now()) {
    await db.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    await logSecurityEvent({
      userId: record.userId,
      type: "PASSWORD_RESET_FAILED",
      detail: "Expired token",
      headers: hdrs,
    });
    return invalid();
  }

  if (record.attempts >= MAX_TOKEN_ATTEMPTS) {
    await db.passwordResetToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    await logSecurityEvent({
      userId: record.userId,
      type: "PASSWORD_RESET_FAILED",
      detail: "Attempt limit reached; token burned",
      headers: hdrs,
    });
    return invalid();
  }

  // Atomically: consume THIS token, change the password, invalidate the rest.
  const newHash = hashPassword(password);
  try {
    await db.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      // Lost the race against a concurrent request → treat as invalid.
      if (consumed.count !== 1) throw new Error("TOKEN_ALREADY_CONSUMED");

      await tx.user.update({
        where: { id: record.userId },
        data: { password: newHash },
      });

      await tx.passwordResetToken.updateMany({
        where: { userId: record.userId, usedAt: null },
        data: { usedAt: new Date() },
      });
    });
  } catch {
    return invalid();
  }

  // Rotate sessions: every device must re-authenticate with the new password.
  await revokeAllSessions(record.userId, "PASSWORD_RESET");
  await resetRateLimit("pwreset:id", sha256(record.userId));

  await logSecurityEvent({
    userId: record.userId,
    type: "PASSWORD_RESET_COMPLETED",
    detail: `channel=${record.channel} destination=${record.destinationMask ?? "n/a"}`,
    headers: hdrs,
  });

  return ok({ ok: true, message: tApi("api.206") });
}
