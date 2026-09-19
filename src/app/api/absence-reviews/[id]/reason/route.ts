// CodeMind Academy — Phase F: submit the absence reason.
//
//   POST /api/absence-reviews/[id]/reason  { reason }
//
// WHO MAY SUBMIT: the case's OWN student, or a PARENT LINKED to that student.
// Nobody else — not a teacher, not an unrelated parent, not an admin (the
// admin's own note belongs to the decision). The reason is append-only: a
// re-submission keeps the previous text in `AbsenceReasonSubmission` and
// mirrors the newest one onto the case, and it never reopens a decided case.
//
// The student and the linked parent are told the case moved to review, and the
// ADMIN QUEUE gains the case with the reason + its author (audited).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, requireUser } from "@/lib/api";
import { ApiFailure, failureResponse, readBody } from "@/lib/live-session-api";
import { getAbsenceCase, parentChildIds, submitAbsenceReason } from "@/lib/absence-review";
import { canSubmitReason } from "@/lib/absence-policy";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readBody(req);
  const now = new Date();

  try {
    const payload = await getAbsenceCase(id, { now });
    if (!payload) throw new ApiFailure(404, "ABSENCE_NOT_FOUND", "Absence case not found");

    let role: "STUDENT" | "PARENT" | null = null;
    if (user.role === "STUDENT") {
      const student = await db.student.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!student || student.id !== payload.student.id) {
        throw new ApiFailure(404, "ABSENCE_NOT_FOUND", "Absence case not found");
      }
      role = "STUDENT";
    } else if (user.role === "PARENT") {
      const parent = await db.parent.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!parent) throw new ApiFailure(404, "PARENT_NOT_FOUND", "Parent profile not found");
      const children = await parentChildIds(parent.id);
      if (!children.includes(payload.student.id)) {
        throw new ApiFailure(404, "ABSENCE_NOT_FOUND", "Absence case not found");
      }
      role = "PARENT";
    }
    if (!role) {
      throw new ApiFailure(403, "NOT_AUTHORIZED", "Only the student or a linked parent may submit a reason");
    }
    if (!canSubmitReason(payload.status)) {
      // The case is already decided: the reason would be history only, so the
      // API refuses instead of opening a reopened-looking state.
      throw new ApiFailure(409, "ABSENCE_ALREADY_DECIDED", "This absence case is already decided", {
        status: payload.status,
      });
    }

    const result = await submitAbsenceReason({
      reviewId: id,
      actorUserId: user.id,
      actorRole: role,
      reason: body.reason,
      now,
    });
    return ok({ case: result.case, status: result.status, submissionId: result.submissionId });
  } catch (error) {
    return failureResponse(error);
  }
}
