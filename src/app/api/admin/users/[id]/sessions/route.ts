// Admin device/session inspection & revocation.
//   GET    /api/admin/users/[id]/sessions  — list active + recent sessions
//   DELETE /api/admin/users/[id]/sessions  — revoke all (or one via ?sessionId=)
//
// Only ADMIN may see or revoke sessions. Raw session tokens are never
// returned — only their metadata.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { logSecurityEvent } from "@/lib/security";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, isActive: true, status: true },
  });
  if (!target) return err("User not found", 404);

  const sessions = await db.userSession.findMany({
    where: { userId: id },
    orderBy: { lastSeenAt: "desc" },
    take: 25,
    select: {
      id: true,
      deviceHash: true,
      userAgent: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
      revokedAt: true,
      revokedReason: true,
    },
  });

  const securityEvents = await db.securityEvent.findMany({
    where: { userId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, type: true, detail: true, createdAt: true },
  });

  const now = new Date();
  return ok({
    user: target,
    sessions: sessions.map((s) => ({
      ...s,
      // Short, non-reversible label so an admin can tell devices apart.
      deviceLabel: s.deviceHash.slice(0, 8),
      isActive: !s.revokedAt && s.expiresAt > now,
    })),
    securityEvents,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const sessionId = new URL(req.url).searchParams.get("sessionId");

  const result = await db.userSession.updateMany({
    where: {
      userId: id,
      revokedAt: null,
      ...(sessionId ? { id: sessionId } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: "ADMIN_REVOKED" },
  });

  await logSecurityEvent({
    userId: id,
    type: "SESSION_REVOKED",
    detail: `Revoked ${result.count} session(s) by admin ${user?.id}`,
  });

  return ok({ revoked: result.count });
}
