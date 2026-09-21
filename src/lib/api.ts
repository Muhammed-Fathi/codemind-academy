// CodeMind Academy — API helpers
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { getServerT } from "@/lib/i18n-server";
import type { Role } from "@prisma/client";
import type { ProgressionUnmetEntry } from "@/lib/progression";
import { checkRateLimit, logSecurityEvent } from "@/lib/security";
import {
  enforceRateLimit,
  type RateLimitEnforcement,
  type RateLimitKey,
} from "@/lib/rate-limit";

export async function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export async function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

// ---------------------------------------------------------------------------
// Phase 20 — shared rate limiting
// ---------------------------------------------------------------------------
//
// One composition point for the DB-backed primitive (`checkRateLimit`) and the
// pure policy module (`rate-limit.ts`). Every protected endpoint calls
// `applyRateLimit` and, on refusal, returns `rateLimitedResponse`. The
// identifier is derived from the authenticated user's id (hashed inside
// `rate-limit.ts`), so the limiter is per-user and multi-process safe.

/** Run the shared limiter for an authenticated user. */
export async function applyRateLimit(
  key: RateLimitKey,
  userId: string
): Promise<RateLimitEnforcement> {
  const enforcement = await enforceRateLimit({
    key,
    userId,
    check: checkRateLimit,
  });
  if (!enforcement.allowed) {
    // Observability: blocks are audited (never fail the request — the helper
    // swallows its own errors). The detail names the limiter, not the user.
    await logSecurityEvent({
      userId,
      type: "RATE_LIMITED",
      detail: `limiter=${key}`,
    });
  }
  return enforcement;
}

/**
 * Public-surface variant of `applyRateLimit` for requests with no authenticated
 * user (e.g. a teacher application submitted by email identity). The identifier
 * is hashed inside `rate-limit.ts`, so no raw email/IP lands in the table, and
 * the block is audited WITHOUT a userId.
 */
export async function applyRateLimitForIdentifier(
  key: RateLimitKey,
  identifier: string
): Promise<RateLimitEnforcement> {
  const enforcement = await enforceRateLimit({
    key,
    userId: identifier,
    check: checkRateLimit,
  });
  if (!enforcement.allowed) {
    await logSecurityEvent({
      userId: null,
      type: "RATE_LIMITED",
      detail: `limiter=${key}`,
    });
  }
  return enforcement;
}

/** Build the 429 response for a refused request (Retry-After + X-RateLimit-*). */
export function rateLimitedResponse(
  enforcement: Extract<RateLimitEnforcement, { allowed: false }>
) {
  return NextResponse.json(enforcement.body, {
    status: 429,
    headers: enforcement.headers,
  });
}

/**
 * Reasons produced by the canonical progression engine (`src/lib/progression`,
 * via the `src/lib/session-progress` adapter). Kept as plain string literals
 * here so this module never has to import the progression service at runtime.
 */
export type ProgressionDenial =
  | "NOT_ENROLLED"
  | "LESSON_NOT_FOUND"
  | "PREVIOUS_SESSION_INCOMPLETE"
  | "ABSENCE_HOLD";

/**
 * Optional Arabic-first explanation attached to a 403 progression denial.
 * Safe by design: stable unmet codes + a human-readable reason + the
 * progression state. Never quiz answers, never media URLs, never protected
 * identities — component PRESENCE on a locked lesson is public skeleton
 * (the course tree already shows it), not protected content.
 */
export type ProgressionDenialDetails = {
  state?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  unmet?: readonly ProgressionUnmetEntry[] | null;
  holdBlocked?: boolean;
} | null | undefined;

/**
 * Uniform denial for a resource gated by session progression (quiz, homework,
 * lesson content, video progress).
 *
 *   * `LESSON_NOT_FOUND` -> 404. The resource either does not exist or is not
 *     attached to a course the gate can verify; both look identical so the
 *     response never confirms that an id is real.
 *   * `ABSENCE_HOLD` -> 403 with the Arabic catch-up message: an active
 *     absence hold blocks forward progression until the student catches up.
 *   * anything else -> 403 with a machine-readable `code`.
 *
 * Phase H: a denial is never a bare LOCKED. Callers that hold the canonical
 * evaluation pass `details` so the student sees WHAT to do next (Arabic
 * reason + structured unmet requirements) instead of a generic refusal.
 */
export async function denyProgression(
  reason: ProgressionDenial | null | undefined,
  notFoundMessage = "Not found",
  details: ProgressionDenialDetails = null
) {
  const tApi = await getServerT();
  if (reason === "LESSON_NOT_FOUND") return err(notFoundMessage, 404);
  // A denial with no reason is a programming error, not an authorization
  // decision — it still refuses the request (403) rather than falling open.
  const code: ProgressionDenial =
    reason === "NOT_ENROLLED" ||
    reason === "PREVIOUS_SESSION_INCOMPLETE" ||
    reason === "ABSENCE_HOLD"
      ? reason
      : "PREVIOUS_SESSION_INCOMPLETE";
  const error =
    code === "NOT_ENROLLED"
      ? tApi("api.208")
      : code === "ABSENCE_HOLD"
        ? "عندك غياب محتاج تعويض"
        : tApi("api.209");
  return NextResponse.json(
    {
      error,
      code,
      // Arabic-first explanation (safe subset only — see the type contract).
      ...(details
        ? {
            state: details.state ?? null,
            reason: details.reason ?? null,
            reasonCode: details.reasonCode ?? null,
            unmet: details.unmet ? [...details.unmet] : [],
            holdBlocked: details.holdBlocked ?? code === "ABSENCE_HOLD",
          }
        : {}),
    },
    { status: 403 }
  );
}

export async function requireUser() {
  const u = await getCurrentUser();
  if (!u) return null;
  return u;
}

export async function requireRole(...roles: Role[]) {
  const u = await getCurrentUser();
  if (!u) return { user: null, error: err("Unauthorized", 401) };
  if (!roles.includes(u.role)) {
    return { user: null, error: err("Forbidden", 403) };
  }
  return { user: u, error: null };
}

export async function getStudentProfile(userId: string) {
  return db.student.findUnique({
    where: { userId },
    include: {
      user: true,
      group: { include: { course: true, teacher: { include: { user: true } } } },
      subscription: { include: { plan: true, payments: true } },
    },
  });
}

export async function getParentProfile(userId: string) {
  return db.parent.findUnique({
    where: { userId },
    include: {
      user: true,
      children: { include: { student: { include: { user: true, group: { include: { course: true } } } } } },
    },
  });
}

export async function getTeacherProfile(userId: string) {
  return db.teacher.findUnique({
    where: { userId },
    include: {
      user: true,
      groups: { include: { course: true, students: { include: { user: true } } } },
    },
  });
}
