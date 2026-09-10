// GET /api/admin/lessons/[id]/readiness — the readiness checklist, ADMIN only.
//
// WHY THIS ROUTE EXISTS
//   The admin has to know WHY a session cannot be opened yet. This endpoint is
//   therefore not a convenience: without it the OPEN ceremony is a black box
//   that says 409. It exists so the Phase 15 admin UI can render the checklist
//   it will find in `readiness.items`.
//
// THE ONE RULE THAT MAKES IT SAFE
//   It calls the SAME `getLessonReadiness` the OPEN ceremony calls, so the
//   answer it gives and the judgement the ceremony makes are the same
//   computation over the same rows — a preview that disagrees with its own
//   ceremony would be worse than no preview. There is no second readiness
//   implementation in this repository, and adding one is the defect this file
//   exists to prevent.
//
// It never touches student data: no enrollment, no progress, no attempt rows,
// no submission rows, nothing per-pupil. It describes the LESSON's own
// completeness, and it is ADMIN-only (a teacher reviewing content is Phase 15
// scope, deliberately not claimed here).

import { NextRequest } from "next/server";
import { ok, err, requireRole } from "@/lib/api";
import { getLessonReadiness, lifecyclePayload } from "@/lib/session-lifecycle";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const loaded = await getLessonReadiness(id);
  if (!loaded) return err("Lesson not found", 404);

  const { publication, isPublished, ...readiness } = loaded;
  return ok({
    lesson: {
      id: readiness.lessonId,
      officialCode: readiness.officialCode,
      curriculumStatus: readiness.curriculumStatus,
      trackScope: readiness.trackScope,
      // The lifecycle block is the SAME projection the ceremony returns, so an
      // admin reading a checklist and an admin pressing Open see one model.
      ...lifecyclePayload(
        { status: readiness.status, isPublished },
        { readiness, publication }
      ),
    },
    readiness,
  });
}
