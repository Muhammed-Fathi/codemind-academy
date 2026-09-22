// POST /api/admin/progression-overrides/[id]/revoke
//
// Revoke a progression override (Phase H). ADMIN only. Append-only: the row
// survives with `revokedAt` set so the audit trail stays complete.
// Idempotent: revoking twice replays (`replay: true`), no second audit row.
// Body: { reason? } — optional revocation note (≤500 chars).

import { NextRequest } from "next/server";
import {
  ok,
  err,
  requireRole,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import { revokeProgressionOverride } from "@/lib/progression";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const rl = await applyRateLimit("progress", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const result = await revokeProgressionOverride({
    overrideId: id,
    actorUserId: user.id,
    reason: body.reason,
  });
  if (!result.ok) {
    return err(result.message, result.code === "OVERRIDE_NOT_FOUND" ? 404 : 400);
  }
  return ok({ overrideId: id, replay: result.replay });
}
