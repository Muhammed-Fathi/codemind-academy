// POST /api/admin/teacher-applications/[id]/approve — approve a PENDING
// application and mint the single-use activation token (admin only).
//
// Phase 20 (Security Hardening II). Approval does NOT create a User, does NOT
// assign a password, and does NOT authenticate the applicant. It only flips
// the application to APPROVED and emails a short-lived, single-use activation
// link. The applicant sets their own password through /api/auth/teacher-activate.

import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { maskEmail, logSecurityEvent } from "@/lib/security";
import { approveTeacherApplication } from "@/lib/teacher-applications";
import { sendEmail } from "@/lib/delivery";
import { getServerT } from "@/lib/i18n-server";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const hdrs = await headers();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;

  const outcome = await approveTeacherApplication({ id, adminUserId: user.id });
  if (!outcome.ok) {
    if (outcome.reason === "NOT_FOUND") return err(tApi("api.263"), 404);
    // ALREADY_ACTIVATED / REJECTED — an illegal transition, never a leak.
    return err(tApi("api.264"), 409);
  }

  if (outcome.alreadyApproved) {
    return ok({ ok: true, alreadyApproved: true });
  }

  const destination = outcome.application.email;
  const destinationMask = maskEmail(destination);
  const appUrl = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";
  const link = `${appUrl}/?teacherActivation=${encodeURIComponent(outcome.activationToken!)}`;

  const delivery = await sendEmail({
    to: destination,
    maskedTo: destinationMask,
    subject: "CodeMind Academy — Teacher application approved",
    text: `Your teacher application was approved. Set your account password here (valid ${process.env.TEACHER_ACTIVATION_TTL_HOURS || 72} hours): ${link}\n\nIf you did not apply, ignore this email.`,
    html: `<p>Your teacher application was approved.</p><p><a href="${link}">Set your teacher password</a></p><p>If you did not apply, ignore this email.</p>`,
  });

  // Audit contains only the MASKED destination and delivery outcome — never
  // the secret, never SMTP credentials.
  await logSecurityEvent({
    userId: user.id,
    type: "TEACHER_APPLICATION_APPROVED",
    detail: `applicationId=${outcome.application.id} delivered=${delivery.delivered}`,
    headers: hdrs,
  });
  await logSecurityEvent({
    userId: null,
    type: "TEACHER_ACTIVATION_ISSUED",
    detail: `applicationId=${outcome.application.id} destination=${destinationMask}`,
    headers: hdrs,
  });

  return ok({ ok: true, alreadyApproved: false });
}
