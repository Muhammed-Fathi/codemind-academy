import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser } from "@/lib/api";
import {
  createProgressionOverride,
  revokeProgressionOverride,
  validateOverrideReason,
  OverrideError,
} from "@/lib/progression-override";

// GET /api/admin/progression-overrides?studentId=...&lessonId=...
// Admin-only: list overrides (filtered), auditable history.

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "ADMIN") return err("Forbidden", 403);

  const { searchParams } = new URL(req.url);
  const studentId = searchParams.get("studentId")?.trim() || null;
  const lessonId = searchParams.get("lessonId")?.trim() || null;
  const courseId = searchParams.get("courseId")?.trim() || null;
  const includeRevoked = searchParams.get("includeRevoked") === "true";

  const where: any = {};
  if (studentId) where.studentId = studentId;
  if (lessonId) where.lessonId = lessonId;
  if (courseId) where.courseId = courseId;
  if (!includeRevoked) {
    where.revokedAt = null;
    where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }];
  }

  const overrides = await db.progressionOverride.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      student: { select: { id: true, user: { select: { name: true, email: true } } } },
      lesson: { select: { id: true, title: true, titleAr: true, officialCode: true, unit: { select: { part: { select: { courseId: true } } } }, topic: { select: { unit: { select: { part: { select: { courseId: true } } } } } } } },
      createdBy: { select: { id: true, name: true } },
      revokedBy: { select: { id: true, name: true } },
    },
  });

  return ok({ overrides });
}

// POST /api/admin/progression-overrides
// Body: { studentId, lessonId, reason, expiresAt?, courseId? }
// Creates an admin override (idempotent if active already exists).

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "ADMIN") return err("Forbidden", 403);

  const body = await req.json().catch(() => ({}));
  const studentId = String(body.studentId || "").trim();
  const lessonId = String(body.lessonId || "").trim();
  const reason = body.reason;
  const courseId = body.courseId ? String(body.courseId).trim() : null;
  let expiresAt: Date | null = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (!isNaN(d.getTime())) expiresAt = d;
  }

  if (!studentId) return err("studentId is required", 400);
  if (!lessonId) return err("lessonId is required", 400);

  const validated = validateOverrideReason(reason);
  if (!validated.ok) {
    const msg =
      validated.code === "REASON_REQUIRED"
        ? "السبب مطلوب"
        : validated.code === "REASON_TOO_SHORT"
          ? "السبب قصير جداً"
          : "السبب طويل جداً";
    return err(msg, 400);
  }

  try {
    const result = await createProgressionOverride({
      studentId,
      lessonId,
      courseId,
      reason,
      createdByUserId: user.id,
      expiresAt,
    });
    return ok({ override: result.override, created: result.created }, result.created ? 201 : 200);
  } catch (e: any) {
    if (e instanceof OverrideError) {
      return err(e.message, e.status);
    }
    console.error("[progression-override] create error", e);
    return err("Failed to create override", 500);
  }
}

// DELETE /api/admin/progression-overrides?id=...
// Revokes an override (soft revoke, preserves audit history).

export async function DELETE(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "ADMIN") return err("Forbidden", 403);

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id")?.trim() || null;
  const bodyId = await req
    .json()
    .then((b: any) => String(b?.id || "").trim())
    .catch(() => null);
  const overrideId = id || bodyId;
  if (!overrideId) return err("id is required", 400);

  try {
    const result = await revokeProgressionOverride({ overrideId, revokedByUserId: user.id });
    return ok({ override: result.override, revoked: result.revoked });
  } catch (e: any) {
    if (e instanceof OverrideError) return err(e.message, e.status);
    console.error("[progression-override] revoke error", e);
    return err("Failed to revoke override", 500);
  }
}
