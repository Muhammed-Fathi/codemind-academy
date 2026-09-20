// CodeMind Academy — Phase H: revoke an Admin progression override.
//
//   POST /api/admin/progression/overrides/[id]/revoke  { reason? }
//
// ADMIN ONLY (checked here and again inside the write path). Revocation never
// deletes the row: the override keeps existing as the record of the decision,
// with the revoking actor, the instant and the reason. Idempotent — revoking an
// already-revoked (or already-expired) row reports it unchanged instead of
// failing, so a retried request cannot produce a second audit event.

import { NextRequest } from "next/server";
import { ok, err, requireRole } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import {
  ProgressionOverrideError,
  revokeProgressionOverride,
  toOverrideView,
} from "@/lib/progression-overrides";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  try {
    const result = await revokeProgressionOverride({
      overrideId: id,
      actorUserId: user.id,
      actorRole: user.role,
      reason: body?.reason,
    });
    return ok({
      override: toOverrideView(result.override, new Date()),
      revoked: result.revoked,
    });
  } catch (error) {
    if (error instanceof ProgressionOverrideError) {
      const message =
        error.code === "NOT_AUTHORIZED"
          ? tApi("admin.progression.adminOnly")
          : error.code === "OVERRIDE_NOT_FOUND"
            ? tApi("admin.progression.notFound")
            : tApi("admin.001");
      return err(message, error.status);
    }
    return err(tApi("admin.001"), 500);
  }
}
