import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  ok,
  err,
  requireUser,
  getStudentProfile,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import { canAccessLesson } from "@/lib/session-progress";
import { getServerT } from "@/lib/i18n-server";

// POST /api/lessons/[id]/progress
// Body: { progress?: number, completed?: boolean }
// Upserts LessonProgress for the current student.
//
// Phase H — completion is DERIVED, never claimed. A client POSTing
// `{ completed: true }` (or `{ progress: 100 }`) used to self-certify the
// legacy `isCompleted` marker with only a video guard — a client claim of
// progression state. The canonical engine is now the verdict: the marker is
// set only when the lesson is COMPLETED by derivation (required video ≥
// threshold, every required quiz PASSED, every required homework SUBMITTED).
// A premature claim is refused (403) with the Arabic reason + structured
// unmet requirements — never a bare refusal. Legacy `isCompleted: true` rows
// are preserved untouched; this route only ever mirrors the derivation
// forward (or records an explicit `{ completed: false }` opt-out).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  // Phase 20 — shared limiter (see rate-limit.ts). Applied before the gating
  // computation so a spammy client cannot DoS the progression query.
  const rl = await applyRateLimit("progress", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const s = await getStudentProfile(user.id);
  if (!s) return err("Student profile not found", 404);

  const lesson = await db.lesson.findUnique({ where: { id } });
  if (!lesson) return err("Lesson not found", 404);

  // Backend authorization: enrollment + the canonical progression verdict are
  // enforced here, not only hidden in the UI. `access.status` IS the
  // canonical evaluation of this lesson for this student.
  const tApi = await getServerT();
  const access = await canAccessLesson(s.id, id);
  if (!access.allowed) {
    if (access.reason === "NOT_ENROLLED") return err(tApi("api.208"), 403);
    if (access.reason === "LESSON_NOT_FOUND") return err("Lesson not found", 404);
    if (access.reason === "ABSENCE_HOLD") return err("عندك غياب محتاج تعويض", 403);
    return err(tApi("api.209"), 403);
  }

  const body = await req.json().catch(() => ({}));
  const progressValue =
    typeof body.progress === "number"
      ? Math.max(0, Math.min(100, body.progress))
      : undefined;
  const completedFlag =
    typeof body.completed === "boolean" ? body.completed : undefined;

  const data: {
    progress?: number;
    isCompleted?: boolean;
    lastViewedAt: Date;
  } = { lastViewedAt: new Date() };

  // The canonical completion verdict for this lesson (derived from
  // server-tracked facts only — video watch, quiz passes, submissions).
  // `videoWatchedSec` / `videoPercent` are only ever written by the heartbeat
  // route, which credits real elapsed wall-clock time; quiz `passed` is only
  // ever written by the server-side grader; `submittedAt` only by the submit
  // gate — so this check cannot be satisfied by a forged request.
  const engineCompleted = access.status?.completed === true;
  const refusePremature = () =>
    ok(
      {
        error: access.status?.reason ?? tApi("api.209"),
        code: "REQUIREMENTS_UNMET",
        state: access.status?.state ?? null,
        reason: access.status?.reason ?? null,
        reasonCode: access.status?.reasonCode ?? null,
        unmet: access.status?.unmet ?? [],
      },
      { status: 403 }
    );

  if (progressValue !== undefined) {
    data.progress = progressValue;
    if (progressValue >= 100) {
      if (!engineCompleted) return refusePremature();
      data.isCompleted = true;
    }
  }
  if (completedFlag !== undefined) {
    if (completedFlag) {
      if (!engineCompleted) return refusePremature();
      data.isCompleted = true;
      if (progressValue === undefined) data.progress = 100;
    } else {
      // Explicit opt-out: the student clears their own legacy marker. The
      // canonical derivation is unaffected (a later claim re-derives).
      data.isCompleted = false;
    }
  }

  const lp = await db.lessonProgress.upsert({
    where: { studentId_lessonId: { studentId: s.id, lessonId: id } },
    update: data,
    create: {
      studentId: s.id,
      lessonId: id,
      progress: data.progress ?? 0,
      isCompleted: data.isCompleted ?? false,
      lastViewedAt: new Date(),
    },
  });

  return ok({
    lessonId: id,
    progress: lp.progress,
    isCompleted: lp.isCompleted,
    lastViewedAt: lp.lastViewedAt,
    // Canonical derivation (additive): the UI renders completion from this.
    completed: engineCompleted,
    state: access.status?.state ?? null,
    reason: access.status?.reason ?? null,
    reasonCode: access.status?.reasonCode ?? null,
    unmet: access.status?.unmet ?? [],
  });
}
