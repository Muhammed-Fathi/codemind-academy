// CodeMind Academy — Phase F: the ADMIN decision on an absence case.
//
//   POST /api/absence-reviews/[id]/decision  { decision: "EXCUSE" | "UNEXCUSE", note? }
//
// ADMIN ONLY. This is the single place where an absence becomes EXCUSED or
// UNEXCUSED, where the AbsenceHold is written (RESOLVED for an excuse, ACTIVE
// for an unexcused absence), where the student + linked parents are notified,
// and where the platform audits the decision together with the admin identity
// and the timestamp.
//
// It does NOT touch academic progression: an EXCUSED absence never unlocks the
// next Lesson by itself (Phase H owns catch-up access), and an UNEXCUSED one
// never deletes content. The hold is a STATE OUTPUT of Phase F.

import { NextRequest, NextResponse } from "next/server";
import { ok, requireUser } from "@/lib/api";
import { ApiFailure, failureResponse, readBody } from "@/lib/live-session-api";
import { decideAbsence } from "@/lib/absence-review";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") {
    throw new ApiFailure(403, "NOT_AUTHORIZED", "Only an admin may decide an absence case");
  }
  const { id } = await params;
  const body = await readBody(req);

  try {
    const result = await decideAbsence({
      reviewId: id,
      adminUserId: user.id,
      decision: body.decision,
      note: body.note,
    });
    return ok({
      case: result.case,
      decision: result.decision,
      hold: result.hold,
      notified: result.notified,
    });
  } catch (error) {
    return failureResponse(error);
  }
}
