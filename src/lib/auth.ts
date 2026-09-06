import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import {
  sha256,
  generateToken,
  deviceHashFromHeaders,
  hashIp,
  logSecurityEvent,
} from "@/lib/security";

// Session is stored in an httpOnly cookie holding a high-entropy random token.
// The server keeps only the SHA-256 of that token in the `UserSession` table,
// together with device metadata used for single-device enforcement.

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "STUDENT" | "PARENT" | "TEACHER" | "ADMIN";
  avatarUrl?: string | null;
  status?: "ACTIVE" | "INACTIVE" | "SUSPENDED_MULTI_DEVICE";
};

const SESSION_COOKIE = "cm_session";
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
/** Sessions idle longer than this are considered abandoned, not "concurrent". */
const IDLE_GRACE_MS = 1000 * 60 * 30; // 30 minutes
/** Only touch lastSeenAt at most this often, to avoid a write per request. */
const LAST_SEEN_THROTTLE_MS = 1000 * 60; // 1 minute

// --- password hashing (scrypt) ----------------------------------------------
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = scryptSync(password, salt, 64);
  const hashBuf = Buffer.from(hash, "hex");
  return hashBuf.length === test.length && timingSafeEqual(test, hashBuf);
}

// --- session management (cookie-based) --------------------------------------
import { cookies, headers } from "next/headers";

export type CreateSessionResult = {
  /** True when an existing active session on a DIFFERENT device was replaced. */
  conflict: boolean;
};

/**
 * Create a server-tracked session for `userId`.
 *
 * Single-device policy: if the user already has a live (non-revoked,
 * non-expired, recently-seen) session from a DIFFERENT device, that is a
 * genuine concurrent-use conflict. We then revoke every session and suspend
 * the account. Logging in again from the SAME device simply rotates the token
 * and never triggers a suspension, so normal behaviour (re-login, new tab,
 * network change) is safe.
 */
export async function createSession(userId: string): Promise<CreateSessionResult> {
  const hdrs = await headers().catch(() => new Headers());
  const deviceHash = deviceHashFromHeaders(hdrs as Headers);
  const now = new Date();

  const liveSessions = await db.userSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { lastSeenAt: "desc" },
  });

  const conflicting = liveSessions.filter(
    (s) =>
      s.deviceHash !== deviceHash &&
      now.getTime() - s.lastSeenAt.getTime() < IDLE_GRACE_MS
  );

  // Same-device (or stale) sessions are just superseded — no suspension.
  const supersede = liveSessions.filter((s) => !conflicting.includes(s));
  if (supersede.length) {
    await db.userSession.updateMany({
      where: { id: { in: supersede.map((s) => s.id) } },
      data: { revokedAt: now, revokedReason: "SUPERSEDED" },
    });
  }

  if (conflicting.length > 0) {
    await db.userSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: "MULTI_DEVICE_CONFLICT" },
    });
    await db.user.update({
      where: { id: userId },
      data: { status: "SUSPENDED_MULTI_DEVICE", isActive: false },
    });
    await logSecurityEvent({
      userId,
      type: "ACCOUNT_SUSPENDED_MULTI_DEVICE",
      detail: `Concurrent session detected from a different device (${conflicting.length} active).`,
      headers: hdrs as Headers,
    });
    return { conflict: true };
  }

  const token = generateToken(32);
  const expires = new Date(Date.now() + SESSION_TTL * 1000);
  await db.userSession.create({
    data: {
      userId,
      tokenHash: sha256(token),
      deviceHash,
      userAgent: (hdrs as Headers).get("user-agent")?.slice(0, 300) || null,
      ipHash: hashIp(
        (hdrs as Headers).get("x-forwarded-for")?.split(",")[0]?.trim()
      ),
      expiresAt: expires,
    },
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
    path: "/",
  });
  return { conflict: false };
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.userSession
      .updateMany({
        where: { tokenHash: sha256(token), revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "LOGOUT" },
      })
      .catch(() => {});
    // Backward compatibility: clear any legacy Setting-based session row.
    await db.setting
      .deleteMany({ where: { key: `session:${token}` } })
      .catch(() => {});
    store.delete(SESSION_COOKIE);
  }
}

/** Revoke every session of a user (used after password reset / by admin). */
export async function revokeAllSessions(userId: string, reason: string) {
  await db.userSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export type CurrentUserResult =
  | { user: SessionUser; reason: null }
  | { user: null; reason: "NO_SESSION" | "EXPIRED" | "REVOKED" | "SUSPENDED" | "INACTIVE" };

/**
 * Resolve the current user AND the reason when resolution fails, so callers can
 * distinguish "not logged in" from "account suspended for multi-device use".
 */
export async function getCurrentUserDetailed(): Promise<CurrentUserResult> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return { user: null, reason: "NO_SESSION" };

  const now = new Date();
  const session = await db.userSession.findUnique({
    where: { tokenHash: sha256(token) },
  });

  let userId: string | null = null;

  if (session) {
    if (session.revokedAt) return { user: null, reason: "REVOKED" };
    if (session.expiresAt.getTime() < now.getTime())
      return { user: null, reason: "EXPIRED" };
    userId = session.userId;
    // Throttled last-seen touch (keeps conflict detection accurate cheaply).
    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await db.userSession
        .update({ where: { id: session.id }, data: { lastSeenAt: now } })
        .catch(() => {});
    }
  } else {
    // ---- Backward compatibility with pre-upgrade Setting-based sessions ----
    const legacy = await db.setting
      .findUnique({ where: { key: `session:${token}` } })
      .catch(() => null);
    if (!legacy) return { user: null, reason: "NO_SESSION" };
    const [legacyUserId, expiresStr] = legacy.value.split("|");
    if (!legacyUserId || !expiresStr) return { user: null, reason: "NO_SESSION" };
    if (new Date(expiresStr).getTime() < now.getTime()) {
      await db.setting.delete({ where: { id: legacy.id } }).catch(() => {});
      return { user: null, reason: "EXPIRED" };
    }
    userId = legacyUserId;
    // Migrate the legacy session into UserSession so device control applies.
    const hdrs = await headers().catch(() => new Headers());
    await db.userSession
      .create({
        data: {
          userId,
          tokenHash: sha256(token),
          deviceHash: deviceHashFromHeaders(hdrs as Headers),
          userAgent: (hdrs as Headers).get("user-agent")?.slice(0, 300) || null,
          expiresAt: new Date(expiresStr),
        },
      })
      .catch(() => {});
    await db.setting.delete({ where: { id: legacy.id } }).catch(() => {});
  }

  const user = await db.user.findUnique({ where: { id: userId! } });
  if (!user) return { user: null, reason: "NO_SESSION" };
  if (user.status === "SUSPENDED_MULTI_DEVICE")
    return { user: null, reason: "SUSPENDED" };
  if (!user.isActive || user.status === "INACTIVE")
    return { user: null, reason: "INACTIVE" };

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      avatarUrl: user.avatarUrl,
      status: user.status as SessionUser["status"],
    },
    reason: null,
  };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const { user } = await getCurrentUserDetailed();
  return user;
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
