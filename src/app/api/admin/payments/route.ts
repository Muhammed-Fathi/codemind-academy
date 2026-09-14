// GET /api/admin/payments?status=&page=1&pageSize=20
//
// The ADMIN payment-review READ contract (Phase 25 PR3).
//
// What changed in PR3 — and what did NOT:
//   * READ-ONLY projection only. This route still writes nothing: no
//     `$transaction`, no `payment.update`, no decision. Approve/reject remain
//     the ONLY writers, and they live in the PR2b decision routes +
//     `src/lib/payment-transitions.ts` (the single decision service).
//   * The projection gained the fields the review drawer needs to be
//     TRUTHFUL: the request side (`senderPhone`, `requestedPlan`,
//     `requestedGroup`, `reviewedAt`, `rejectionReason`, the duplicate-
//     reference warning) and the student's CURRENT entitlement context
//     (group, plan, status, end date, access).
//   * the reviewer-audit column is deliberately NOT selected or returned (this
//     file does not even name it): the reviewer identity stays server-side and
//     the ledger test keeps the decision service as that column's only writer.
//     No internal notes beyond the pre-existing `notes` column, no raw
//     database errors.
//
// The entitlement context is labelled with the SAME pure policy the rest of
// the platform uses (`evaluateAccessDecision` + `describeSubscriptionState`
// from `src/lib/subscription-entitlement.ts`) — one batched read here instead
// of a per-student resolver call, but byte-for-byte the same rules, so the
// queue can never disagree with the student's own dashboard.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, requireRole } from "@/lib/api";
import { referenceComparisonKey } from "@/lib/payment-submission";
import {
  describeSubscriptionState,
  evaluateAccessDecision,
} from "@/lib/subscription-entitlement";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const status = url.searchParams.get("status")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const where: any = {};
  if (status === "PENDING" || status === "APPROVED" || status === "REJECTED") {
    where.status = status;
  }

  const [total, payments, pendingReferences] = await Promise.all([
    db.payment.count({ where }),
    db.payment.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, role: true } },
        subscription: { select: { id: true, status: true, plan: { select: { nameAr: true } } } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    // Whole-queue PENDING view (not just this page) — the source of two
    // DISPLAY-ONLY warnings:
    //   * duplicate reference: counted over EVERY pending request, so a
    //     repeated reference is flagged even when the two rows sit on
    //     different pages. A WARNING only — never a rejection, never a
    //     uniqueness constraint (PR1 rule: reference is not a key);
    //   * "newer request exists": the newest-first ordering the student read
    //     contract already publishes (createdAt DESC, id DESC), so an older
    //     pending row of the same student can be BADGED as non-authoritative.
    // Neither duplicates a decision rule: the server's stale guard in
    // `src/lib/payment-transitions.ts` stays the authority, and a badge can
    // never approve or reject anything.
    db.payment.findMany({
      where: { status: "PENDING" },
      select: { id: true, userId: true, reference: true, createdAt: true },
    }),
  ]);

  const pendingRows = pendingReferences as {
    id: string;
    userId: string;
    reference: string | null;
    createdAt: Date | string;
  }[];

  const pendingKeyCounts = new Map<string, number>();
  for (const row of pendingRows) {
    if (!row.reference) continue;
    const key = referenceComparisonKey(String(row.reference));
    pendingKeyCounts.set(key, (pendingKeyCounts.get(key) ?? 0) + 1);
  }
  const isDuplicateReference = (statusValue: string, reference: string | null): boolean => {
    if (String(statusValue).toUpperCase() !== "PENDING" || !reference) return false;
    return (pendingKeyCounts.get(referenceComparisonKey(String(reference))) ?? 0) > 1;
  };

  // Newest pending request per user (createdAt DESC, id DESC — the same
  // ordering the student read contract and the server's stale guard use).
  const newestPendingByUser = new Map<string, string>();
  for (const row of pendingRows) {
    const current = newestPendingByUser.get(row.userId);
    if (!current) {
      newestPendingByUser.set(row.userId, row.id);
      continue;
    }
    const currentRow = pendingRows.find((r) => r.id === current);
    if (!currentRow) {
      newestPendingByUser.set(row.userId, row.id);
      continue;
    }
    const a = new Date(row.createdAt).getTime();
    const b = new Date(currentRow.createdAt).getTime();
    if (a > b || (a === b && String(row.id) > String(currentRow.id))) {
      newestPendingByUser.set(row.userId, row.id);
    }
  }

  // ---- Requested plan / group display names (FK-less by design, so resolve
  // defensively: a deleted row reads null, never an error) ----
  const planIds = [
    ...new Set(
      (payments as any[]).map((p) => p.requestedPlanId).filter((v): v is string => !!v)
    ),
  ];
  const groupIds = [
    ...new Set(
      (payments as any[]).map((p) => p.requestedGroupId).filter((v): v is string => !!v)
    ),
  ];
  const [plans, groups] = await Promise.all([
    planIds.length
      ? db.subscriptionPlan.findMany({
          where: { id: { in: planIds } },
          select: { id: true, name: true, nameAr: true, durationMonths: true, price: true, isActive: true },
        })
      : Promise.resolve([]),
    groupIds.length
      ? db.group.findMany({
          where: { id: { in: groupIds } },
          select: {
            id: true,
            name: true,
            isActive: true,
            capacity: true,
            courseId: true,
            schedule: true,
            _count: { select: { students: true } },
          },
        })
      : Promise.resolve([]),
  ]);
  const planById = new Map((plans as any[]).map((p) => [p.id, p]));
  const groupById = new Map((groups as any[]).map((g) => [g.id, g]));

  // ---- CURRENT entitlement context (batched, shared pure policy) ----
  const userIds = [...new Set((payments as any[]).map((p) => p.userId))] as string[];
  const students = userIds.length
    ? await db.student.findMany({
        where: { userId: { in: userIds } },
        select: {
          id: true,
          userId: true,
          groupId: true,
          parentPhone: true,
          group: { select: { id: true, name: true, isActive: true, courseId: true } },
          subscription: {
            select: {
              id: true,
              status: true,
              startDate: true,
              endDate: true,
              plan: { select: { id: true, name: true, nameAr: true } },
            },
          },
        },
      })
    : [];
  const studentByUserId = new Map((students as any[]).map((s) => [s.userId, s]));
  const now = new Date();

  const contextFor = (userId: string) => {
    const student = studentByUserId.get(userId) as any | undefined;
    if (!student) return null;
    const subscription = student.subscription ?? null;
    const decision = evaluateAccessDecision(
      {
        groupActive:
          !!student.groupId &&
          student.group?.isActive === true &&
          student.group?.courseId != null,
        subscription,
      },
      now
    );
    const info = describeSubscriptionState(subscription, now);
    return {
      id: student.id as string,
      parentPhone: (student.parentPhone as string | null) ?? null,
      groupId: (student.groupId as string | null) ?? null,
      groupName: (student.group?.name as string | undefined) ?? null,
      /** Course of the CURRENT group — scopes the admin group-override list. */
      courseId: (student.group?.courseId as string | undefined) ?? null,
      currentPlanName: subscription?.plan
        ? subscription.plan.nameAr || subscription.plan.name
        : null,
      subscriptionStatus: info.rawStatus,
      hasSubscription: decision.hasSubscription,
      accessAllowed: decision.allowed,
      grandfathered: decision.grandfathered,
      /** UI-truth label — never "ACTIVE" for a PENDING row. */
      state: info.state,
      startDate: info.startDate,
      endDate: info.endDate,
      daysToExpiry: info.daysToExpiry,
    };
  };

  return ok({
    payments: payments.map((p: any) => {
      const requestedPlan = p.requestedPlanId ? planById.get(p.requestedPlanId) ?? null : null;
      const requestedGroup = p.requestedGroupId ? groupById.get(p.requestedGroupId) ?? null : null;
      return {
        id: p.id,
        userId: p.userId,
        userName: p.user.name,
        userEmail: p.user.email,
        userPhone: p.user.phone ?? null,
        userRole: p.user.role,
        amount: p.amount,
        method: p.method,
        status: p.status,
        reference: p.reference,
        notes: p.notes,
        createdAt: p.createdAt,
        subscription: p.subscription,
        // ---- PR3 review context (read-only) ----
        senderPhone: p.senderPhone ?? null,
        requestedGroupId: p.requestedGroupId ?? null,
        requestedPlanId: p.requestedPlanId ?? null,
        requestedPlan: requestedPlan
          ? {
              id: requestedPlan.id,
              name: requestedPlan.name,
              nameAr: requestedPlan.nameAr,
              durationMonths: requestedPlan.durationMonths,
              price: requestedPlan.price,
              isActive: requestedPlan.isActive,
            }
          : null,
        requestedGroup: requestedGroup
          ? {
              id: requestedGroup.id,
              name: requestedGroup.name,
              isActive: requestedGroup.isActive,
              capacity: requestedGroup.capacity,
              courseId: requestedGroup.courseId,
              schedule: requestedGroup.schedule,
              seatsUsed: requestedGroup._count?.students ?? 0,
            }
          : null,
        reviewedAt: p.reviewedAt ?? null,
        rejectionReason: p.rejectionReason ?? null,
        duplicateReference: isDuplicateReference(p.status, p.reference),
        /**
         * Display hint only: this PENDING row is NOT the student's newest
         * pending request, so deciding it would be refused server-side
         * (STALE_PAYMENT). `null` for already-decided rows.
         */
        isLatestPending:
          String(p.status).toUpperCase() === "PENDING"
            ? newestPendingByUser.get(p.userId) === p.id
            : null,
        /** The student's CURRENT entitlement + group (shared policy). */
        studentContext: contextFor(p.userId),
      };
    }),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
    },
  });
}
