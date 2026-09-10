// POST /api/admin/lessons/[id]/mark-ready — stage a session as READY after validating it
//
// The ceremony lives in `src/lib/session-lifecycle.ts`; this route is thin on
// purpose: authenticate as ADMIN, resolve the id, run the ceremony, map the
// outcome. Every rule (archived lessons are untouchable, a lesson must belong
// to a course, readiness must hold, idempotent replay, the transactional write, the audit
// row) is enforced in the shared helper, so the endpoint cannot drift from the
// library and the library can be tested without HTTP.
//
// NO NOTIFICATIONS ARE SENT HERE. Phase 13 writes the `SessionPublication` row
// that Phase 17 will consume and stops. No `NEW_LESSON` notification, no
// fan-out, no delivery call.

import { NextRequest } from "next/server";
import { ok, err, requireRole } from "@/lib/api";
import { markLessonReady, lifecycleHttpStatus } from "@/lib/session-lifecycle";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const result = await markLessonReady({ lessonId: id, actorUserId: user?.id ?? null });
  const status = lifecycleHttpStatus(result.code);
  const body = {
    ok: result.ok,
    code: result.code,
    action: result.action,
    changed: result.changed,
    lessonId: result.lessonId,
    from: result.from,
    to: result.to,
    message: result.message,
    // The checklist travels with the verdict: a refusal is actionable without
    // a second request, and a success shows what was verified to produce it.
    readiness: result.readiness,
    publication: result.publication,
  };
  if (status === 404) return err(result.message, 404);
  return ok(body, { status });
}
