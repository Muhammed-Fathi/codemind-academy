// CodeMind Academy — shared rate limiting (Phase 20).
//
// ONE mechanism for every abuse-sensitive endpoint. This module is PURE: it
// imports nothing but node:crypto, so it compiles and runs in the offline test
// suite without a database, without Next.js, and without the Prisma engine.
// The database-backed primitive lives in `src/lib/security.ts`
// (`checkRateLimit`) — this module owns the POLICY (what each endpoint is
// allowed to do) and the OBSERVABILITY (headers + machine codes), and routes
// compose the two through `applyRateLimit` in `src/lib/api.ts`.
//
// THE CONTRACT
// ============
//  1. DETERMINISTIC — a fixed window over a DB row keyed by
//     (bucket, identifier). The same sequence of requests always yields the
//     same decision, and the counter survives restarts.
//  2. BOUNDED — every key has a hard default; env overrides are clamped to a
//     sane range so a misconfigured value degrades to a safe bound instead of
//     disabling the limiter or overflowing the window.
//  3. OBSERVABLE — 429 responses carry `Retry-After` plus `X-RateLimit-Limit`
//     / `X-RateLimit-Remaining`, and blocks are written to the security audit
//     log by the caller.
//  4. MULTI-PROCESS SAFE — the counter is in the DATABASE (SecurityRateLimit),
//     never in memory, so the documented single-standalone-server deployment
//     and any future multi-instance deployment share one authority.
//  5. NO PII — identifiers are SHA-256 hashes keyed by the limiter scope; the
//     raw user id never lands in the table.

import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Keys + defaults
// ---------------------------------------------------------------------------

export type RateLimitKey =
  | "heartbeat"
  | "progress"
  | "open"
  | "notification"
  | "materialDownload"
  | "pdfUpload"
  | "teacherApply";

export const RATE_LIMIT_KEYS: readonly RateLimitKey[] = [
  "heartbeat",
  "progress",
  "open",
  "notification",
  "materialDownload",
  "pdfUpload",
  "teacherApply",
] as const;

export type RateLimitConfig = {
  limit: number;
  windowSec: number;
  blockSec: number;
};

/**
 * Default policy. Bounded and deliberate:
 *   - heartbeat / progress / materialDownload are high-frequency STUDENT
 *     surfaces (video playheads, PDF re-reads) — per-minute windows.
 *   - open / notification / pdfUpload are low-frequency ADMIN actions — much
 *     lower limits with a block window so a stuck script is locked out
 *     briefly rather than for a full hour.
 */
export const DEFAULT_RATE_LIMITS: Record<RateLimitKey, RateLimitConfig> = {
  heartbeat: { limit: 300, windowSec: 60, blockSec: 60 },
  progress: { limit: 120, windowSec: 60, blockSec: 60 },
  open: { limit: 20, windowSec: 60, blockSec: 300 },
  notification: { limit: 30, windowSec: 60, blockSec: 300 },
  materialDownload: { limit: 120, windowSec: 60, blockSec: 60 },
  pdfUpload: { limit: 30, windowSec: 60, blockSec: 300 },
  // Public surface — one application attempt per hour per email identity,
  // with an hour-long block after abuse (a human applies once).
  teacherApply: { limit: 5, windowSec: 3600, blockSec: 3600 },
} as const;

/** env var name per key — `RATE_LIMIT_HEARTBEAT`, `RATE_LIMIT_OPEN`, … */
export const RATE_LIMIT_ENV: Record<RateLimitKey, string> = {
  heartbeat: "RATE_LIMIT_HEARTBEAT",
  progress: "RATE_LIMIT_PROGRESS",
  open: "RATE_LIMIT_OPEN",
  notification: "RATE_LIMIT_NOTIFICATION",
  materialDownload: "RATE_LIMIT_MATERIAL_DOWNLOAD",
  pdfUpload: "RATE_LIMIT_PDF_UPLOAD",
  teacherApply: "RATE_LIMIT_TEACHER_APPLY",
} as const;

// Hard bounds applied to every resolved config (fail-closed on bad env).
export const RATE_LIMIT_BOUNDS = {
  limitMin: 1,
  limitMax: 1_000_000,
  windowMinSec: 1,
  windowMaxSec: 86_400,
  blockMinSec: 1,
  blockMaxSec: 86_400,
} as const;

// ---------------------------------------------------------------------------
// Config resolution (env override with clamping)
// ---------------------------------------------------------------------------

/**
 * Parse an env override of the form `limit` or `limit/windowSec/blockSec`.
 * Returns null for an unset/empty/non-numeric value (which falls back to the
 * default policy). Numeric components are passed through RAW — including 0 and
 * out-of-range values — so that `clampRateLimitConfig` can clamp them into the
 * hard bounds rather than silently disabling the limiter.
 */
export function parseRateLimitOverride(
  raw: string | undefined | null
): Partial<RateLimitConfig> | null {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;

  const parts = text.split("/").map((p) => p.trim());
  if (parts.length < 1 || parts.length > 3) return null;
  // Strictly numeric — "not-a-number", "5abc", "-1" and empty components all
  // fall back to the default rather than being half-parsed.
  if (parts.some((p) => !/^\d+$/.test(p))) return null;

  const [limit, windowSec, blockSec] = parts.map((p) => Number.parseInt(p, 10));
  return { limit, windowSec, blockSec };
}

/**
 * Clamp a candidate config into the hard bounds. An OMITTED component keeps the
 * base (default) value; a PRESENT component is clamped into [min, max], so a
 * 0 or negative degrades to the minimum — it can never disable the limiter.
 */
export function clampRateLimitConfig(
  input: Partial<RateLimitConfig>,
  base: RateLimitConfig
): RateLimitConfig {
  const clamp = (n: number, lo: number, hi: number) =>
    Math.min(Math.max(Math.floor(n), lo), hi);
  return {
    limit:
      input.limit === undefined
        ? base.limit
        : clamp(input.limit, RATE_LIMIT_BOUNDS.limitMin, RATE_LIMIT_BOUNDS.limitMax),
    windowSec:
      input.windowSec === undefined
        ? base.windowSec
        : clamp(input.windowSec, RATE_LIMIT_BOUNDS.windowMinSec, RATE_LIMIT_BOUNDS.windowMaxSec),
    blockSec:
      input.blockSec === undefined
        ? base.blockSec
        : clamp(input.blockSec, RATE_LIMIT_BOUNDS.blockMinSec, RATE_LIMIT_BOUNDS.blockMaxSec),
  };
}

/**
 * Resolve the effective config for a key. Env override wins when it parses;
 * anything unparseable falls back to the default (never disables the limiter).
 */
export function resolveRateLimitConfig(
  key: RateLimitKey,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): RateLimitConfig {
  const base = DEFAULT_RATE_LIMITS[key];
  const override = parseRateLimitOverride(env[RATE_LIMIT_ENV[key]]);
  if (!override) return base;
  return clampRateLimitConfig(override, base);
}

// ---------------------------------------------------------------------------
// Identifiers / headers / body
// ---------------------------------------------------------------------------

/**
 * Hash an endpoint-scoped identifier so the SecurityRateLimit table never
 * stores a raw user id. The scope prefix keeps the same user's budgets on
 * different endpoints independent even if two buckets were to collide.
 */
export function rateLimitIdentifier(key: RateLimitKey, userId: string): string {
  return createHash("sha256").update(`rl:${key}:${userId}`).digest("hex");
}

/** The bucket name stored in SecurityRateLimit.bucket. */
export function rateLimitBucket(key: RateLimitKey): string {
  return `rl:${key}`;
}

/** Result shape the DB primitive returns (structural — matches security.ts). */
export type RateLimitCheckResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
};

/** Injectable check — routes pass `checkRateLimit` from src/lib/security.ts. */
export type RateLimitCheck = (
  bucket: string,
  identifier: string,
  limit: number,
  windowSec: number,
  blockSec: number
) => Promise<RateLimitCheckResult>;

export function rateLimitHeaders(
  cfg: RateLimitConfig,
  result: RateLimitCheckResult
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(cfg.limit),
    "X-RateLimit-Remaining": String(Math.max(0, Math.floor(result.remaining))),
  };
  if (!result.allowed) {
    headers["Retry-After"] = String(Math.max(1, Math.ceil(result.retryAfterSec)));
  }
  return headers;
}

export const RATE_LIMITED_CODE = "RATE_LIMITED";

/** Uniform 429 body. Machine code only — callers may localise the message. */
export function rateLimitedBody(
  message = "Too many requests"
): { error: string; code: typeof RATE_LIMITED_CODE } {
  return { error: message, code: RATE_LIMITED_CODE };
}

export type RateLimitEnforcement =
  | { allowed: true; headers: Record<string, string>; config: RateLimitConfig }
  | {
      allowed: false;
      headers: Record<string, string>;
      config: RateLimitConfig;
      retryAfterSec: number;
      body: { error: string; code: typeof RATE_LIMITED_CODE };
    };

/**
 * Enforce a limit. Pure with respect to storage: the counter check is
 * injected (`check`), so this function is exercised directly by the offline
 * suite with a deterministic fake, while production routes inject the real
 * DB-backed `checkRateLimit`.
 */
export async function enforceRateLimit(params: {
  key: RateLimitKey;
  userId: string;
  env?: Record<string, string | undefined>;
  check: RateLimitCheck;
  message?: string;
}): Promise<RateLimitEnforcement> {
  const config = resolveRateLimitConfig(params.key, params.env);
  const result = await params.check(
    rateLimitBucket(params.key),
    rateLimitIdentifier(params.key, params.userId),
    config.limit,
    config.windowSec,
    config.blockSec
  );
  const headers = rateLimitHeaders(config, result);
  if (result.allowed) {
    return { allowed: true, headers, config };
  }
  return {
    allowed: false,
    headers,
    config,
    retryAfterSec: result.retryAfterSec,
    body: rateLimitedBody(params.message),
  };
}
