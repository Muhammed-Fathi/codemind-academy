// CodeMind Academy — Phase F: the ADMIN operational overview.
//
//   GET /api/admin/live-ops
//     → today's sessions, upcoming sessions, unfinalized registers, sessions
//       flagged ATTENDANCE_INCOMPLETE / TEACHER_NO_SHOW, absences pending
//       review, cancelled and rescheduled sessions in the horizon, and the
//       repeated-absence signal (factual counts, no consequences).
//     → the LISTS behind every counter, computed from the same payloads the
//       admin workspace renders, so a number can never disagree with the list
//       under it.
//
// ADMIN ONLY. Teachers get the same information scoped to their own sessions
// through /api/teacher/live-sessions; students and parents never see any of it.

import { NextRequest } from "next/server";
import { ok, requireRole } from "@/lib/api";
import { ApiFailure, failureResponse, dateParam, intParam } from "@/lib/live-session-api";
import {
  buildAdminOpsOverview,
  listSessionsForAdmin,
  listSessionsNeedingReview,
} from "@/lib/live-sessions";
import { listAbsenceQueue } from "@/lib/absence-review";
import type { AbsenceQueueFilter } from "@/lib/absence-policy";

export async function GET(req: NextRequest) {
  // The canonical admin guard (`requireRole("ADMIN")`) — the same one every
  // other route under /api/admin uses, and the one the security-hardening
  // contract asserts for this namespace.
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const now = new Date();
  const limit = intParam(url.searchParams.get("limit"), 50, 1, 200);

  try {
    const overview = await buildAdminOpsOverview({ now });
    const [sessions, needsReview, pendingAbsences] = await Promise.all([
      listSessionsForAdmin({
        from: dateParam(url.searchParams.get("from")) ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        to: dateParam(url.searchParams.get("to")) ?? new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
        groupId: url.searchParams.get("groupId"),
        teacherId: url.searchParams.get("teacherId"),
        status: url.searchParams.get("status"),
        q: url.searchParams.get("q"),
        limit,
        now,
      }),
      listSessionsNeedingReview({ now, limit }),
      listAbsenceQueue(
        { status: (url.searchParams.get("absenceStatus") as AbsenceQueueFilter | null) ?? "PENDING_REVIEW", limit },
        { now }
      ),
    ]);

    return ok({
      overview,
      sessions,
      needsReview,
      pendingAbsences,
      generatedAt: now.toISOString(),
    });
  } catch (error) {
    return failureResponse(error);
  }
}
