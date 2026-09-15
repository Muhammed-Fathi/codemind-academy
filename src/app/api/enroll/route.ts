// CodeMind Academy — POST /api/enroll — ENROLLMENT/PAYMENT SUBMISSION V2 (Phase 25 PR2a).
//
// THE PHASE 25 CONTRACT
//   This endpoint records a manual-payment REQUEST (InstaPay / e& Cash).
//   It never grants access:
//     * Payment is created PENDING carrying its own intent — `senderPhone`,
//       `reference`, `requestedGroupId`, `requestedPlanId` (PR1 ledger fields);
//     * a NEW / unentitled student gets their singleton Subscription set to
//       PENDING (no paid access while the request is pending);
//     * a LEGACY GRANDFATHERED student (ACTIVE group bound to a course, no
//       Subscription row) gets a PENDING Payment ONLY — no Subscription row
//       is created, so their grandfathered access stays fully intact (a row,
//       once present, would be authoritative and lock them out; PR2b creates
//       it on approval, with `Payment.subscriptionId` NULL until then);
//     * an ACTIVE, unexpired renewal leaves the current Subscription and
//       Student.groupId UNTOUCHED (the request is Payment history only);
//     * `Student.groupId` is NOT assigned here — assignment, activation,
//       date stacking, capacity locking and batch reconciliation happen when
//       an admin APPROVES the payment.
//
//   ╔══════════════════════════════════════════════════════════════════════╗
//   ║ RELEASE COUPLING — THIS PR IS NOT INDEPENDENTLY DEPLOYABLE.          ║
//   ║ PR2a + PR2b + PR3 ship as ONE atomic production release. The CURRENT ║
//   ║ (legacy) approval handler does NOT consume Payment.requestedGroupId/ ║
//   ║ requestedPlanId and does not assign Student.groupId, so deploying     ║
//   ║ PR2a without PR2b would strand every new student in a forbidden      ║
//   ║ APPROVED-but-unassigned state. Do not "fix" the legacy handler here. ║
//   ╚══════════════════════════════════════════════════════════════════════╝
//
// Authorization: identity is resolved from the authenticated session ONLY.
// Nothing in the body selects a user, a subscription, a status or an approval
// — a student cannot enroll "for" someone else, cannot self-approve, and
// cannot point their account at a group before approval.
//
// Validation kept from the legacy flow (course/group/plan/coupon rules and the
// pre-check that the chosen group is not full) and extended with the Phase 25
// requirements: senderPhone (required, Egyptian mobile via the shared phone
// helpers) and reference (required, deliberately loose — no format gate that
// could reject a legitimate bank reference, and NO uniqueness rule: repeated
// references are history, flagged on read, never the source of a DB
// constraint). Duplicate/stale pending payments are intentionally NOT
// auto-cancelled here: PR2b resolves which pending request is authoritative.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { reconcileStudentBatch } from "@/lib/enrollment";
import { groupTrackScopeEligible } from "@/lib/track-scope";
import {
  submitPaymentRequest,
  validateEnrollmentSubmission,
} from "@/lib/payment-submission";
import { resolveStudentEntitlement } from "@/lib/subscription-entitlement";

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.081"), 403);

  const body = await req.json().catch(() => ({}));
  const { courseId, groupId, planId, method, reference, senderPhone, couponCode } =
    body as {
      courseId?: string;
      groupId?: string;
      planId?: string;
      method?: string;
      reference?: string;
      senderPhone?: string;
      couponCode?: string;
    };
  if (!courseId || !groupId || !planId || !method)
    return err(tApi("api.082"), 400);

  // Phase 25 PR2a — submission contract validation (method support, sender
  // phone, transaction reference). Normalization/validation rules live in the
  // shared module so the tests exercise the shipped behavior directly.
  const validated = validateEnrollmentSubmission(
    { method, senderPhone, reference },
    tApi
  );
  if ("error" in validated)
    return err(validated.error.message, validated.error.status);

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.083"), 404);

  const plan = await db.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) return err(tApi("api.084"), 404);

  // Phase 26B — plan availability is enforced at SUBMISSION, not only at
  // approval (`payment-transitions` already refuses an inactive plan with
  // PLAN_NOT_FOUND). A plan the admin closed for sale (e.g. Early Bird) must
  // never be purchasable by direct API tampering: it is hidden from
  // /api/subscription-plans AND refused here. The approved decision-layer
  // copy (api.276) is reused so the student sees the same "plan not
  // available" truth in both places. Students already holding a live
  // entitlement are unaffected — the entitlement policy never reads
  // plan.isActive.
  if (!plan.isActive) return err(tApi("api.276"), 400);

  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { id: true },
  });
  if (!course) return err(tApi("api.085"), 404);

  const group = await db.group.findUnique({
    where: { id: groupId },
    // Phase 26B — `trackScope` is the eligibility input for the audience
    // check below.
    select: { id: true, courseId: true, isActive: true, capacity: true, trackScope: true },
  });
  if (!group || !group.isActive) return err(tApi("api.085"), 404);

  // Security Audit Gate (pre-P21) — COURSE / GROUP BINDING.
  //
  // Nothing on the server tied `groupId` to `courseId`, so a student could
  // post any ACTIVE group id from any course. Enrollment is derived from
  // `Student.groupId -> Group.courseId` (src/lib/enrollment.ts), so that
  // single unchecked id immediately granted the curriculum of another course
  // (any lesson whose track scope the student's own school type admits), plus
  // a seat the group owner never sold.
  //
  // The pair is now validated together; the refusal reuses the
  // "group not available" message so it never confirms which ids are real.
  // Phase 25: the same binding rule still applies to the REQUESTED group —
  // the intent stored on the Payment can never name a foreign course.
  if (group.courseId !== course.id) return err(tApi("api.085"), 400);

  // Phase 26B — GROUP AUDIENCE ELIGIBILITY (owner-approved schema change).
  // A group's explicit audience (`Group.trackScope`, ARABIC | LANGUAGE) must
  // match the student's OWN persisted school type — a request the UI would
  // never produce (the picker already filters) is rejected here, so tampered
  // requests can never even CREATE a Payment/Subscription, let alone grant a
  // seat. Unclassified (null) groups are refused for everyone until an admin
  // classifies them; a student whose school type is unknown is refused for
  // every group (fail-closed). The refusal reuses the "group not available"
  // message so a prober learns nothing about which group ids exist.
  if (!groupTrackScopeEligible(student.schoolType, group.trackScope))
    return err(tApi("api.085"), 400);

  // Pre-check only: the seat may be gone by the time an admin approves; the
  // authoritative capacity decision (with advisory locking) is PR2b's job at
  // approval time. This never reserves anything.
  const filled = await db.student.count({ where: { groupId } });
  if (filled >= group.capacity) return err(tApi("api.086"), 400);

  // Validate coupon if provided (existing business rules, unchanged).
  let coupon: any = null;
  let finalAmount = plan.price;
  let discount = 0;
  if (couponCode) {
    const upperCode = couponCode.trim().toUpperCase();
    coupon = await db.coupon.findUnique({
      where: { code: upperCode },
      include: { redemptions: { where: { userId: user.id } } },
    });
    if (!coupon) return err(tApi("api.087"), 404);
    if (!coupon.isActive) return err(tApi("api.088"), 400);
    if (coupon.usedCount >= coupon.maxUses) return err(tApi("api.089"), 400);
    if (coupon.validUntil && new Date() > coupon.validUntil)
      return err(tApi("api.090"), 400);
    if (coupon.redemptions.length > 0) return err(tApi("api.091"), 400);

    if (coupon.type === "PERCENTAGE") {
      discount = Math.round((plan.price * coupon.value) / 100);
    } else {
      discount = Math.min(coupon.value, plan.price);
    }
    finalAmount = plan.price - discount;
  }

  // Create the PENDING request(s) — one transaction, three scenarios
  // (NEW_REQUEST vs RENEWAL vs LEGACY_GRANDFATHERED), no group assignment
  // (see the module header).
  const result = await submitPaymentRequest({
    db,
    userId: user.id,
    studentId: student.id,
    groupId,
    plan: { id: plan.id, price: plan.price },
    amount: finalAmount,
    notes: coupon ? `Coupon: ${coupon.code} (-${discount} EGP)` : null,
    coupon: coupon ? { id: coupon.id, code: coupon.code } : null,
    method: validated.input.method,
    senderPhone: validated.input.senderPhone,
    reference: validated.input.reference,
    notify: {
      title: tApi("api.092"),
      message: tApi("api.093", { p1: user.name }),
      link: "admin-payments",
    },
  });

  // Phase 12 batch-healing stays wired on this write path — but note what it
  // can and cannot do under PR2a: submission never touches `Student.groupId`,
  // so there is no course change to reconcile here; the call is the
  // idempotent HEAL (wrong/stale batch → corrected) the Phase 12 invariant
  // requires of every student write path, and it runs AFTER the transaction
  // commits so it can never half-apply. GROUP RECONCILIATION FOR NEW
  // STUDENTS IS PR2b's APPROVAL JOB (it assigns the group and reconciles
  // afterwards); the session videos a healed batch exposes stay gated by
  // the entitlement-aware getEnrollment, so a PENDING request still sees
  // nothing.
  const reconciliation = await reconcileStudentBatch(student.id);

  // Truthful read-back of the CURRENT entitlement for the caller: an
  // ACTIVE renewal keeps access (RENEWAL); a grandfathered legacy student
  // keeps access via the group (LEGACY_GRANDFATHERED, no row); a first
  // request from a genuinely new student never reports an active paid
  // entitlement (PENDING Subscription ⇒ accessAllowed false).
  const entitlement = await resolveStudentEntitlement(student.id);

  return ok({ ...result, batchId: reconciliation.batchId, entitlement });
}
