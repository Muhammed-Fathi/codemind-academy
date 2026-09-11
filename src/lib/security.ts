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
 * Best-effort client IP, for ABUSE LIMITING ONLY — never for authorization.
 *
 * TRUST MODEL (Security Audit Gate, pre-P21). `X-Forwarded-For` is appended
 * to by every hop, so its FIRST entry is whatever the outermost client sent
 * unless a trusted proxy rewrites the header. `X-Real-IP` is different: the
 * documented deployment (Caddyfile, docs/DEPLOYMENT_GUIDE.md §1B) sets it
 * unconditionally with `header_up X-Real-IP {remote_host}`, so a proxy that
 * emits it also overwrites any client-supplied value, and a request that
 * reaches the app WITHOUT the proxy carries no `X-Real-IP` at all.
 *
 * We therefore prefer `X-Real-IP` and fall back to the first XFF hop. A
 * spoofed IP can only ever weaken an IP-bucketed *throttle*, never an
 * authorization decision — and every abuse-sensitive endpoint also keys a
 * second, non-spoofable bucket (hashed account identity or hashed token).
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const realIp = headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || null;
}

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
 *
 * Phase 20 — RACE-FREE under concurrency. The pre-Phase-20 implementation did
 * read-modify-write (`findUnique` → `update { count: next }`), which lost
 * increments under contention (admitting more requests than `limit`). Every
 * state change now runs as a single guarded statement, so the limiter is
 * deterministic even across concurrent requests:
 *
 *   1. ensure the row exists — an idempotent atomic `upsert` with an empty
 *      `update` (INSERT … ON CONFLICT DO NOTHING), so concurrent first
 *      requests produce exactly one row;
 *   2. window reset — `UPDATE … SET count=1, windowStart=now WHERE windowStart
 *      <= cutoff`: only ONE concurrent resetter wins, so a burst at the window
 *      boundary cannot all re-open the window;
 *   3. claim — `UPDATE … SET count = count + 1 WHERE count < limit`: exactly
 *      one write per slot below `limit` lands, and the rest observe the block.
 *
 * `client` is injectable (defaults to `db`) so the offline real-DB suite can
 * exercise the SAME implementation against a SQLite adapter — no parallel
 * limiter exists anywhere.
 */
export async function checkRateLimit(
  bucket: string,
  identifier: string,
  limit: number,
  windowSec: number,
  blockSec = windowSec,
  // Injected clients are structural, not nominal — same convention as the
  // lifecycle/material services (tests, CLI, and `db`).
  client: any = db
): Promise<RateLimitResult> {
  const now = new Date();
  const key = { bucket_identifier: { bucket, identifier } };
  const cutoff = new Date(now.getTime() - windowSec * 1000);

  // 1. Ensure the row exists (atomic, idempotent — see the header comment).
  await client.securityRateLimit.upsert({
    where: key,
    create: { bucket, identifier, count: 0, windowStart: now, blockedUntil: null },
    update: {},
  });

  const blocked = (row: { blockedUntil: Date }): RateLimitResult => ({
    allowed: false,
    remaining: 0,
    retryAfterSec: Math.max(
      1,
      Math.ceil((row.blockedUntil.getTime() - now.getTime()) / 1000)
    ),
  });

  let existing = await client.securityRateLimit.findUnique({ where: key });

  // While blocked, refuse without touching the window.
  if (existing?.blockedUntil && existing.blockedUntil > now) {
    return blocked(existing);
  }

  // 2. Window expired → guarded reset (only one concurrent resetter wins).
  if (existing && existing.windowStart.getTime() <= cutoff.getTime()) {
    const reset = await client.securityRateLimit.updateMany({
      where: { bucket, identifier, windowStart: { lte: cutoff } },
      data: { count: 1, windowStart: now, blockedUntil: null },
    });
    if (reset.count === 1) {
      return { allowed: true, remaining: limit - 1, retryAfterSec: 0 };
    }
    // Lost the reset race — the winner moved windowStart to `now`. Re-read and
    // take the normal increment path.
    existing = await client.securityRateLimit.findUnique({ where: key });
    if (existing?.blockedUntil && existing.blockedUntil > now) {
      return blocked(existing);
    }
  }

  // 3. Atomic guarded claim (see the header comment).
  const incremented = await client.securityRateLimit.updateMany({
    where: { bucket, identifier, count: { lt: limit } },
    data: { count: { increment: 1 } },
  });

  if (incremented.count === 1) {
    const row = await client.securityRateLimit.findUnique({ where: key });
    const used = row?.count ?? limit;
    return {
      allowed: true,
      remaining: Math.max(0, limit - used),
      retryAfterSec: 0,
    };
  }

  // Over the limit: (re)arm the block. `update` is safe here because the row
  // provably exists (step 1 created it).
  const blockedUntil = new Date(now.getTime() + blockSec * 1000);
  await client.securityRateLimit
    .update({ where: key, data: { blockedUntil } })
    .catch(() => {});
  return { allowed: false, remaining: 0, retryAfterSec: blockSec };
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
  | "MATERIAL_ACCESSED"
  /** Phase 20 — an endpoint rate limit was exceeded (detail names the limiter). */
  | "RATE_LIMITED"
  /** Phase 20 — Teacher application & admin-approval lifecycle. */
  | "TEACHER_APPLICATION_SUBMITTED"
  | "TEACHER_APPLICATION_BLOCKED"
  | "TEACHER_APPLICATION_APPROVED"
  | "TEACHER_APPLICATION_REJECTED"
  | "TEACHER_ACTIVATION_ISSUED"
  | "TEACHER_ACTIVATION_COMPLETED"
  | "TEACHER_ACTIVATION_FAILED";

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
        ipHash: hashIp(
          params.ip ??
            (params.headers ? clientIpFromHeaders(params.headers) : null)
        ),
        userAgent: params.headers?.get("user-agent")?.slice(0, 300) || null,
      },
    });
  } catch {
    // Never let audit logging break the request path.
  }
}
