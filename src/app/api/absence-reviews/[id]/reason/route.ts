// CodeMind Academy — Phase F: submit the absence reason.
//
//   POST /api/absence-reviews/[id]/reason  { reason }
//
// WHO MAY SUBMIT: the case's OWN STUDENT. Nobody else — not a teacher, not an
// admin (the admin's own note belongs to the decision), and NOT A PARENT.
//
// PHASE I — PARENT IS ACADEMICALLY READ-ONLY (approved product rule).
// Phase F allowed a linked parent to submit an excuse; Phase I removes that.
// Two reasons, both structural rather than cosmetic:
//   1. Submitting an absence excuse is an ACADEMIC WRITE. A parent must never
//      change attendance, finalize it, submit or approve an excuse, modify a
//      review decision or resolve a hold — the restriction has to live
//      SERVER-SIDE, and a hidden UI button is not authorization.
//   2. The parent surface is a FOLLOW-UP surface. The parent already sees the
//      case, its status, the submitted reason, the administrative decision and
//      the resulting hold through `GET /api/absence-reviews` and
//      `GET /api/parents/me/academics` — everything needed to follow up with
//      the academy, nothing that needs a write.
// The refusal is 403 with a stable code (never 404): the parent IS linked to
// this case, so hiding its existence would be dishonest, and a 404 would
// suggest the id was wrong rather than the role. `parentChildIds` is no longer
// imported here on purpose — it is a read-scope helper, not an authorization
// grant.
//
// The reason stays append-only: a re-submission keeps the previous text in
// `AbsenceReasonSubmission` and mirrors the newest one onto the case, and it
// never reopens a decided case.
//
// The student is told the case moved to review, and the ADMIN QUEUE gains the
// case with the reason + its author (audited).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, requireUser } from "@/lib/api";
import { ApiFailure, failureResponse, readBody } from "@/lib/live-session-api";
import { getAbsenceCase, submitAbsenceReason } from "@/lib/absence-review";
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

    // PHASE I — the parent read-only gate fires FIRST and unconditionally: a
    // linked parent may READ this case (GET /api/absence-reviews) but may
    // never write to it. The linkage check is deliberately NOT performed here,
    // so the refusal cannot be mistaken for "you are not linked to this child"
    // — it is a role rule, identical for every case id.
    if (user.role === "PARENT") {
      throw new ApiFailure(
        403,
        "PARENT_READ_ONLY",
        "A parent may view absence information but may not submit or change an absence reason"
      );
    }

    let role: "STUDENT" | null = null;
    if (user.role === "STUDENT") {
      const student = await db.student.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!student || student.id !== payload.student.id) {
        throw new ApiFailure(404, "ABSENCE_NOT_FOUND", "Absence case not found");
      }
      role = "STUDENT";
    }
    if (!role) {
      throw new ApiFailure(403, "NOT_AUTHORIZED", "Only the student may submit a reason");
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
