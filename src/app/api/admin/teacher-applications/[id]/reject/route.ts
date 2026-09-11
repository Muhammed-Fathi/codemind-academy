// POST /api/admin/teacher-applications/[id]/reject — reject an application
// (admin only). Never creates a Teacher account; rescinds any live activation
// token if the application had already been approved.

import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { logSecurityEvent } from "@/lib/security";
import { rejectTeacherApplication } from "@/lib/teacher-applications";
import { getServerT } from "@/lib/i18n-server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const hdrs = await headers();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const note = String(body.note || "").trim().slice(0, 500) || null;

  const outcome = await rejectTeacherApplication({ id, adminUserId: user.id, note });
  if (!outcome.ok) {
    if (outcome.reason === "NOT_FOUND") return err(tApi("api.263"), 404);
    // ALREADY_ACTIVATED — cannot reject an already-provisioned teacher here.
    return err(tApi("api.265"), 409);
  }

  await logSecurityEvent({
    userId: user.id,
    type: "TEACHER_APPLICATION_REJECTED",
    detail: `applicationId=${id} alreadyRejected=${outcome.alreadyRejected}`,
    headers: hdrs,
  });

  return ok({ ok: true, alreadyRejected: outcome.alreadyRejected });
}
