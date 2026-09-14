// GET /api/students/me/payments — Phase 25 PR2a student payment read contract.
//
// What the frontend needs to render the (PR3) payment surface TRUTHFULLY:
//   * `payments`          — the student's own request history, newest first
//                           (PENDING / APPROVED / REJECTED, with `reference`,
//                           `senderPhone`, the requested plan/group, and for a
//                           rejection the admin `rejectionReason` +
//                           `reviewedAt` when present);
//   * `latestPending`     — the pending REQUEST (what the student asked for),
//                           kept SEPARATE from the entitlement on purpose:
//                           a pending request is NOT an active subscription;
//   * `latestRejected`    — the most recent rejection for the retry banner;
//   * `entitlement`       — the CURRENT entitlement singleton: group,
//                           stored subscription status, whether access is
//                           actually allowed right now (lazy expiry applied),
//                           and the legacy-grandfather flag.
//
// SECURITY: there is no id parameter anywhere — ownership is derived from the
// authenticated session (`userId` on the Payment rows, `studentId` resolved
// from the same user), so this route cannot read another student's payments.
// Payment.notes (admin-visible scratch) and every admin-only field are NOT
// selected. Duplicate references are only FLAGGED (`duplicateReference`) —
// never rejected or hidden (PR1 rule: reference is not a uniqueness key).

import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { fetchStudentPayments } from "@/lib/payment-submission";
import { resolveStudentEntitlement } from "@/lib/subscription-entitlement";

export async function GET() {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await db.student.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
  if (!student) return err("Student profile not found", 404);

  const [paymentsRead, entitlement] = await Promise.all([
    fetchStudentPayments(db, user.id),
    resolveStudentEntitlement(student.id),
  ]);

  return ok({ ...paymentsRead, entitlement });
}
