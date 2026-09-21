// /api/admin/progression-overrides — the Admin progression override (Phase H).
//
// POST — grant a named student access to a named lesson as an audited,
//        expirable, revocable EXCEPTION to the canonical engine.
//        Body: { studentId, lessonId, reason, expiresAt? }
//        * ADMIN only (`requireRole("ADMIN")`) — Teacher, Student and Parent
//          are refused before any state is touched.
//        * `reason` is mandatory (3..500 chars, server-validated).
//        * `expiresAt`, when given, must be a future date.
//        * The lesson must be PUBLISHED + non-archived, in the student's
//          enrolled course, and track-eligible for the student. An override
//          NEVER crosses the track boundary and NEVER publishes content.
//        * Idempotent per (student, lesson): re-granting an active override
//          replays the existing row (`replay: true`), no duplicate, no
//          second audit row.
//        * NEVER writes an academic fact: no quiz pass, no submission, no
//          video row, no attendance row, no hold mutation, no COMPLETED
//          rewrite. The engine reports the facts unchanged and marks the
//          access as override-granted.
// GET  — list overrides for audit (`?studentId=` / `?lessonId=` filters).
//        ADMIN only.

import { NextRequest } from "next/server";
import {
  ok,
  err,
  requireRole,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import {
  grantProgressionOverride,
  listProgressionOverrides,
} from "@/lib/progression";

const GRANT_STATUS: Record<string, number> = {
  OVERRIDE_REASON_REQUIRED: 400,
  OVERRIDE_REASON_TOO_LONG: 400,
  OVERRIDE_EXPIRY_INVALID: 400,
  OVERRIDE_EXPIRY_PAST: 400,
  STUDENT_NOT_FOUND: 404,
  LESSON_NOT_FOUND: 404,
  LESSON_NOT_GRANTABLE: 422,
  LESSON_NOT_IN_COURSE: 422,
  TRACK_DENIED: 422,
};

export async function POST(req: NextRequest) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const rl = await applyRateLimit("progress", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => ({}));
  const result = await grantProgressionOverride({
    studentId: String(body.studentId || ""),
    lessonId: String(body.lessonId || ""),
    reason: body.reason,
    expiresAt: body.expiresAt,
    actorUserId: user.id,
  });
  if (!result.ok) {
    return err(result.message, GRANT_STATUS[result.code] ?? 400);
  }
  return ok({ overrideId: result.overrideId, replay: result.replay });
}

export async function GET(req: NextRequest) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  void user;

  const studentId = req.nextUrl.searchParams.get("studentId");
  const lessonId = req.nextUrl.searchParams.get("lessonId");
  const overrides = await listProgressionOverrides({ studentId, lessonId });
  return ok({ overrides });
}
