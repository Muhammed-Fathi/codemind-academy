import { scryptSync, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";

// Session is stored in a signed cookie — we keep it simple with a plain
// session token mapped in DB. (No JWT for MVP simplicity in sandbox.)

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: "STUDENT" | "PARENT" | "TEACHER" | "ADMIN";
  avatarUrl?: string | null;
};

const SESSION_COOKIE = "cm_session";
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days

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
import { cookies } from "next/headers";

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL * 1000);
  // We persist a Setting entry as session store key -> userId (simple approach).
  await db.setting.create({
    data: {
      key: `session:${token}`,
      value: `${userId}|${expires.toISOString()}`,
    },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    expires,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.setting
      .deleteMany({ where: { key: `session:${token}` } })
      .catch(() => {});
    store.delete(SESSION_COOKIE);
  }
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const row = await db.setting.findUnique({
    where: { key: `session:${token}` },
  });
  if (!row) return null;

  const [userId, expiresStr] = row.value.split("|");
  if (!userId || !expiresStr) return null;
  const expires = new Date(expiresStr);
  if (expires.getTime() < Date.now()) {
    await db.setting.delete({ where: { id: row.id } }).catch(() => {});
    return null;
  }

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarUrl: user.avatarUrl,
  };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
