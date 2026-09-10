// GET /api/admin/lessons/[id]/recipients — Phase 17 recipient-count preview
//
// The Open-dialog confirmation numbers: how many students the publication of
// this lesson would notify RIGHT NOW, and how many of them already hold the
// publication's row (delivery progress for a published session).
//
// EVERY number derives from `getEligibleSessionRecipients` — the same helper
// the fan-out delivers to — so what the dialog shows and what the fan-out
// does can never disagree. There is no second count query.
//
// ADMIN-only. A missing lesson is a 404; a lesson attached to no course is a
// 409 with a machine code (it can never be opened, per the ceremony), and
// both answers are the ones the Open ceremony itself would give.

import { NextRequest } from "next/server";
import { ok, err, requireRole } from "@/lib/api";
import { previewSessionPublicationRecipients } from "@/lib/session-notifications";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const preview = await previewSessionPublicationRecipients(id);
  if (preview.code === "LESSON_NOT_FOUND") return err("Lesson not found", 404);
  if (preview.code === "LESSON_NOT_IN_COURSE") {
    return err("LESSON_NOT_IN_COURSE", 409);
  }
  return ok({
    lessonId: preview.lessonId,
    courseId: preview.courseId,
    trackScope: preview.trackScope,
    status: preview.status,
    publication: preview.publication,
    eligible: preview.eligible,
    alreadyNotified: preview.alreadyNotified,
    pending: preview.pending,
    deliverableNow: preview.deliverableNow,
    skippedPreferenceNow: preview.skippedPreferenceNow,
    skippedQuietHoursNow: preview.skippedQuietHoursNow,
    notifiedCount: preview.notifiedCount,
  });
}
