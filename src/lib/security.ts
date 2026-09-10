// CodeMind Academy — Server-side security primitives.
//
// Everything here runs on the server only. Raw tokens/OTPs are NEVER stored,
// logged, or returned to a client that isn't the legitimate recipient.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { getSecurityHashSecret } from "@/lib/env";

// ---------------------------------------------------------------------------
// Hashing / comparison
// ---------------------------------------------------------------------------

/** SHA-256 hex digest — used for token lookups (tokens are high-entropy). */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time string comparison for secrets of equal expected length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Cryptographically secure URL-safe token. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ---------------------------------------------------------------------------
// Privacy helpers
// ---------------------------------------------------------------------------

/**
 * Hash an IP with a server secret so logs are useful for abuse detection but
 * do not store raw personal data.
 */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  // Production REQUIRES SECURITY_HASH_SECRET (see src/lib/env.ts) — there is
  // no hardcoded production fallback.
  const secret = getSecurityHashSecret();
  return sha256(`${secret}:${ip}`).slice(0, 32);
}

/** "someone@example.com" -> "s*****e@example.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  if (local.length <= 2) return `${local[0] ?? "*"}***@${domain}`;
  return `${local[0]}${"*".repeat(Math.min(5, local.length - 2))}${local.at(-1)}@${domain}`;
}

// ---------------------------------------------------------------------------
// Device fingerprint (ADVISORY ONLY — never the sole proof of identity)
// ---------------------------------------------------------------------------

/**
 * Derives a coarse, deliberately STABLE device hash. We intentionally exclude
 * the IP address and any volatile header so that normal network changes
 * (Wi-Fi -> mobile data), IP rotation, or a browser update do NOT look like a
 * new device and cannot accidentally suspend a legitimate user.
 */
export function deviceHashFromHeaders(headers: Headers): string {
  const ua = headers.get("user-agent") || "";
  // Reduce the UA to browser family + OS family only: patch-version bumps and
  // minor UA churn must not produce a different device.
  const browser =
    /Edg\//.test(ua) ? "edge" :
    /OPR\//.test(ua) ? "opera" :
    /Chrome\//.test(ua) ? "chrome" :
    /Firefox\//.test(ua) ? "firefox" :
    /Safari\//.test(ua) ? "safari" : "other";
  const os =
    /Android/.test(ua) ? "android" :
    /iPhone|iPad|iPod/.test(ua) ? "ios" :
    /Windows/.test(ua) ? "windows" :
    /Mac OS X/.test(ua) ? "macos" :
    /Linux/.test(ua) ? "linux" : "other";
  const mobile = headers.get("sec-ch-ua-mobile") || "";
  const platform = headers.get("sec-ch-ua-platform") || "";
  const secret = getSecurityHashSecret();
  return sha256(`${secret}|${browser}|${os}|${mobile}|${platform}`).slice(0, 40);
}

// ---------------------------------------------------------------------------
// Rate limiting (server-side, DB-backed, survives restarts)
// ---------------------------------------------------------------------------

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
};

/**
 * Fixed-window limiter. `identifier` should already be hashed/normalised
 * (e.g. hashed email or hashed IP) so no PII lands in the table.
 */
export async function checkRateLimit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSec: number,
  blockSec = windowSec
): Promise<RateLimitResult> {
  const now = new Date();
  const key = { bucket_identifier: { bucket, identifier } };

  const existing = await db.securityRateLimit.findUnique({ where: key });

  if (existing?.blockedUntil && existing.blockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.ceil((existing.blockedUntil.getTime() - now.getTime()) / 1000),
    };
  }

  const windowExpired =
    !existing || now.getTime() - existing.windowStart.getTime() > windowSec * 1000;

  if (windowExpired) {
    await db.securityRateLimit.upsert({
      where: key,
      create: { bucket, identifier, count: 1, windowStart: now, blockedUntil: null },
      update: { count: 1, windowStart: now, blockedUntil: null },
    });
    return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
  }

  const next = existing.count + 1;
  if (next > limit) {
    const blockedUntil = new Date(now.getTime() + blockSec * 1000);
    await db.securityRateLimit.update({
      where: key,
      data: { count: next, blockedUntil },
    });
    return { allowed: false, remaining: 0, retryAfterSec: blockSec };
  }

  await db.securityRateLimit.update({ where: key, data: { count: next } });
  return { allowed: true, remaining: limit - next, retryAfterSec: 0 };
}

/** Clear a bucket after a legitimate success (e.g. successful password reset). */
export async function resetRateLimit(bucket: string, identifier: string) {
  await db.securityRateLimit
    .deleteMany({ where: { bucket, identifier } })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Security audit log
// ---------------------------------------------------------------------------

export type SecurityEventType =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET_FAILED"
  | "PASSWORD_RESET_COMPLETED"
  | "SESSION_CONFLICT_DETECTED"
  | "ACCOUNT_SUSPENDED_MULTI_DEVICE"
  | "ACCOUNT_REACTIVATED"
  | "SESSION_REVOKED"
  | "QUIZ_EVIDENCE_ACCESSED"
  /** Phase 14 — staff review of a private session PDF. */
  | "MATERIAL_ACCESSED";

/**
 * Append a security event. Callers must pass only redacted details — this
 * function never receives or persists raw tokens/OTPs.
 */
export async function logSecurityEvent(params: {
  userId?: string | null;
  type: SecurityEventType;
  detail?: string | null;
  headers?: Headers;
  ip?: string | null;
}) {
  try {
    await db.securityEvent.create({
      data: {
        userId: params.userId || null,
        type: params.type,
        detail: params.detail || null,
        ipHash: hashIp(params.ip ?? params.headers?.get("x-forwarded-for")?.split(",")[0]?.trim()),
        userAgent: params.headers?.get("user-agent")?.slice(0, 300) || null,
      },
    });
  } catch {
    // Never let audit logging break the request path.
  }
}
