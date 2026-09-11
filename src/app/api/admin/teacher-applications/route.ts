// GET /api/admin/teacher-applications — list teacher applications (admin only)
//
// Phase 20 (Security Hardening II): the review queue for the public
// "become a teacher" flow. Approval/rejection are separate routes; this route
// only lists (filterable by `?status=`), and it never exposes anything that
// would let a client mutate a status.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

const VALID_STATUS = new Set(["PENDING", "APPROVED", "REJECTED", "ACTIVATED"]);

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const statusParam = (url.searchParams.get("status") || "").trim().toUpperCase();

  // A non-status filter is simply ignored (never a server error, never a
  // client-influenced query shape).
  const where: any = {};
  if (statusParam && VALID_STATUS.has(statusParam)) {
    where.status = statusParam;
  }

  const applications = await db.teacherApplication.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      email: true,
      name: true,
      phone: true,
      specialty: true,
      bio: true,
      status: true,
      adminNote: true,
      reviewedAt: true,
      createdAt: true,
      // Reveal only whether the application ever produced a teacher, not the
      // teacher's other data.
      userId: true,
    },
  });

  return ok({ applications });
}
