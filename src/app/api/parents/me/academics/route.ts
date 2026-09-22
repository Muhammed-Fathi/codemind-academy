// GET /api/parents/me/academics?studentId=<linked-student-id>
//
// Phase I — the Parent academic follow-up surface.
//
// WHAT IT RETURNS
//   The selected child's canonical academic situation, assembled ENTIRELY from
//   the Phase F / G / H authorities:
//
//     Phase H  lesson state (LOCKED/UNLOCKED/COMPLETED), current lesson, lock
//              reason, remaining requirements, hold boundary, overrides and
//              catch-up eligibility — `loadCourseProgression` +
//              `evaluateStudentCatchup`, the same evaluation the student
//              surface enforces.
//     Phase F  absence cases (excused / unexcused / pending), active holds,
//              live-session lifecycle (upcoming / rescheduled / cancelled).
//     Phase G  homework lifecycle + deadline-aware submission state and teacher
//              feedback, quiz outcome summaries (NEVER answers).
//
// AUTHORIZATION — "authenticated Parent → active ParentStudentLink → requested
// Student", re-verified on EVERY call. A `studentId` that is not one of this
// parent's own links resolves to 404, identical to an id that does not exist:
// the endpoint never confirms that another child is real. No body field is
// ever read.
//
// READ-ONLY — the handler performs no create/update/upsert/delete, and the
// aggregation layer (`src/lib/parent-academics.ts`) is pure readers + shapers.
// A regression test asserts zero academic writes per request.
//
// PRIVACY — the payload carries no lesson/quiz/homework/hold database ids, no
// quiz answers or answer keys, no submitted answers, no anti-cheat evidence
// and no unpublished content. `studentId` is the single exception: it is the
// approved `?studentId=` contract.

import type { NextRequest } from "next/server";
import { ok, err, requireUser } from "@/lib/api";
import { getServerT, serverLocale } from "@/lib/i18n-server";
import { hasDictKey, translate } from "@/lib/i18n-core";
import {
  listLinkedChildRefs,
  loadChildAcademicSnapshot,
  readStudentIdParam,
  resolveLinkedChild,
} from "@/lib/parent-academics";

/**
 * Resolve a `label` that is EITHER canonical Arabic text (a Phase H reason
 * string) OR an i18n dict key emitted by the aggregation layer. A canonical
 * Arabic string must never be looked up in the dictionary (it would render an
 * empty string), and a dict key must never be shown raw.
 */
function resolveLabel(
  label: string,
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  if (!label) return "";
  return hasDictKey(label) ? t(label) : label;
}

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const locale = await serverLocale();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "PARENT") return err("Forbidden", 403);

  const requested = readStudentIdParam(req);
  const resolution = await resolveLinkedChild(user.id, requested);
  // Unlinked / forged id → 404 (never 403: a 403 would confirm existence).
  if (!resolution) {
    return err(requested ? tApi("api.403") : tApi("api.404"), 404);
  }

  const [snapshot, children] = await Promise.all([
    loadChildAcademicSnapshot({ resolution, locale }),
    listLinkedChildRefs(user.id, locale),
  ]);

  const actionNeeded = snapshot.actionNeeded.map((item) => ({
    ...item,
    label: resolveLabel(item.label, tApi),
  }));

  return ok({
    selectedStudentId: resolution.student.id,
    children,
    snapshot: { ...snapshot, actionNeeded },
  });
}
