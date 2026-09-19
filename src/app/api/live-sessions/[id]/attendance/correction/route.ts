// CodeMind Academy — Phase F: ADMIN attendance correction (the ONLY post-lock
// write path).
//
//   POST /api/live-sessions/[id]/attendance/correction
//        { studentId, newStatus, reason }
//
// A teacher can never reach this endpoint (ADMIN role enforced here), and the
// service records previous status, new status, the MANDATORY reason, the admin
// identity and the timestamp in `AttendanceCorrection` AND in `AuditLog`.
// Correcting an ABSENT row away from ABSENT voids the absence case as
// NO_ACTION_REQUIRED and resolves an active hold — the case is closed, never
// deleted, and no history is silently rewritten.

import { NextRequest } from "next/server";
import { ok, requireRole } from "@/lib/api";
import { ApiFailure, failureResponse, readBody } from "@/lib/live-session-api";
import { correctAttendance } from "@/lib/live-sessions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // ADMIN only, through the platform's canonical guard. A teacher reaches this
  // line and is refused with 403 by the guard itself (never by the UI).
  const { user, error: guardError } = await requireRole("ADMIN");
  if (guardError) return guardError;
  const { id } = await params;
  const body = await readBody(req);

  try {
    const result = await correctAttendance({
      sessionId: id,
      studentId: String(body.studentId ?? ""),
      newStatus: body.newStatus,
      reason: body.reason,
      adminUserId: user.id,
    });
    return ok(result);
  } catch (error) {
    return failureResponse(error);
  }
}
