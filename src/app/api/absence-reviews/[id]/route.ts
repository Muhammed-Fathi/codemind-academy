// CodeMind Academy — Phase F: ONE absence case.
//
//   GET /api/absence-reviews/[id]
//     ADMIN   → the full queue payload (reason history, decision, hold, flags)
//     STUDENT → only their own case
//     PARENT  → only a case of a LINKED child
//     TEACHER → the case of one of their own groups, read-only and WITHOUT the
//               decision controls (a teacher never decides an absence)
// Anything else is a 404, never a 403-with-details.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, requireUser } from "@/lib/api";
import { ApiFailure, failureResponse } from "@/lib/live-session-api";
import { getAbsenceCase, parentChildIds } from "@/lib/absence-review";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) throw new ApiFailure(401, "UNAUTHORIZED", "Unauthorized");
  const { id } = await params;
  const now = new Date();

  try {
    const payload = await getAbsenceCase(id, { now });
    if (!payload) throw new ApiFailure(404, "ABSENCE_NOT_FOUND", "Absence case not found");

    if (user.role === "ADMIN") return ok({ case: payload, scope: "admin", canDecide: true });

    if (user.role === "STUDENT") {
      const student = await db.student.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!student || student.id !== payload.student.id) {
        throw new ApiFailure(404, "ABSENCE_NOT_FOUND", "Absence case not found");
      }
      return ok({ case: payload, scope: "student", canSubmitReason: true, canDecide: false });
    }

    if (user.role === "PARENT") {
      const parent = await db.parent.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!parent) throw new ApiFailure(404, "PARENT_NOT_FOUND", "Parent profile not found");
      const children = await parentChildIds(parent.id);
      if (!children.includes(payload.student.id)) {
        throw new ApiFailure(404, "ABSENCE_NOT_FOUND", "Absence case not found");
      }
      return ok({
        case: payload,
        scope: "parent",
        canSubmitReason: true,
        canDecide: false,
        // Explicit contract for the UI: a parent may never change attendance,
        // excuse an absence, resolve a hold or unlock content.
        permissions: {
          changeAttendance: false,
          excuse: false,
          resolveHold: false,
          unlockContent: false,
          submitReason: true,
          viewReviewState: true,
        },
      });
    }

    if (user.role === "TEACHER") {
      const teacher = await db.teacher.findUnique({
        where: { userId: user.id },
        select: { id: true, groups: { select: { id: true } } },
      });
      if (!teacher) throw new ApiFailure(404, "TEACHER_NOT_FOUND", "Teacher profile not found");
      const owns = payload.group ? teacher.groups.some((g) => g.id === payload.group!.id) : false;
      if (!owns) throw new ApiFailure(404, "ABSENCE_NOT_FOUND", "Absence case not found");
      return ok({ case: payload, scope: "teacher", readOnly: true, canDecide: false, canSubmitReason: false });
    }

    throw new ApiFailure(403, "NOT_AUTHORIZED", "Forbidden");
  } catch (error) {
    return failureResponse(error);
  }
}
