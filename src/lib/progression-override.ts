// CodeMind Academy — Phase H admin progression override service.
//
// Admin-only, auditable, expirable, revocable, idempotent exception/overlay.
// Does NOT fabricate academic facts.

import { db } from "@/lib/db";

export const OVERRIDE_REASON_MIN = 5;
export const OVERRIDE_REASON_MAX = 1000;

export type OverrideFailureCode =
  | "NOT_FOUND"
  | "NOT_AUTHORIZED"
  | "REASON_REQUIRED"
  | "REASON_TOO_SHORT"
  | "REASON_TOO_LONG"
  | "STUDENT_NOT_FOUND"
  | "LESSON_NOT_FOUND"
  | "ALREADY_EXISTS"
  | "EXPIRED";

export class OverrideError extends Error {
  code: OverrideFailureCode;
  status: number;
  constructor(code: OverrideFailureCode, message: string, status = 400) {
    super(message);
    this.name = "OverrideError";
    this.code = code;
    this.status = status;
  }
}

export function validateOverrideReason(
  raw: unknown
): { ok: true; reason: string } | { ok: false; code: OverrideFailureCode } {
  if (typeof raw !== "string") return { ok: false, code: "REASON_REQUIRED" };
  const reason = raw.replace(/\s+/g, " ").trim();
  if (reason.length === 0) return { ok: false, code: "REASON_REQUIRED" };
  if (reason.length < OVERRIDE_REASON_MIN) return { ok: false, code: "REASON_TOO_SHORT" };
  if (reason.length > OVERRIDE_REASON_MAX) return { ok: false, code: "REASON_TOO_LONG" };
  return { ok: true, reason };
}

export type CreateOverrideParams = {
  studentId: string;
  lessonId: string;
  courseId?: string | null;
  reason: unknown;
  createdByUserId: string;
  expiresAt?: Date | null;
};

export async function createProgressionOverride(params: CreateOverrideParams) {
  const validated = validateOverrideReason(params.reason);
  if (!validated.ok) throw new OverrideError(validated.code, "Reason is required", 400);

  const student = await db.student.findUnique({
    where: { id: params.studentId },
    select: { id: true },
  });
  if (!student) throw new OverrideError("STUDENT_NOT_FOUND", "Student not found", 404);

  const lesson = await db.lesson.findUnique({
    where: { id: params.lessonId },
    select: {
      id: true,
      unit: {
        select: {
          part: { select: { courseId: true } },
        },
      },
      topic: {
        select: {
          unit: {
            select: {
              part: { select: { courseId: true } },
            },
          },
        },
      },
    },
  });
  if (!lesson) throw new OverrideError("LESSON_NOT_FOUND", "Lesson not found", 404);

  const courseId =
    params.courseId ||
    lesson.unit?.part.courseId ||
    lesson.topic?.unit.part.courseId ||
    null;

  const now = new Date();
  const existing = await db.progressionOverride.findFirst({
    where: {
      studentId: params.studentId,
      lessonId: params.lessonId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return { override: existing, created: false };
  }

  const created = await db.progressionOverride.create({
    data: {
      studentId: params.studentId,
      lessonId: params.lessonId,
      courseId,
      reason: validated.reason,
      createdByUserId: params.createdByUserId,
      expiresAt: params.expiresAt ?? null,
    },
  });

  await db.auditLog
    .create({
      data: {
        userId: params.createdByUserId,
        action: "PROGRESSION_OVERRIDE_CREATED",
        entity: "ProgressionOverride",
        entityId: created.id,
        details: JSON.stringify({
          studentId: params.studentId,
          lessonId: params.lessonId,
          courseId,
          reason: validated.reason.slice(0, 200),
          expiresAt: params.expiresAt ?? null,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return { override: created, created: true };
}

export async function revokeProgressionOverride(params: {
  overrideId: string;
  revokedByUserId: string;
}) {
  const existing = await db.progressionOverride.findUnique({
    where: { id: params.overrideId },
  });
  if (!existing) throw new OverrideError("NOT_FOUND", "Override not found", 404);
  if (existing.revokedAt) return { override: existing, revoked: false };

  const updated = await db.progressionOverride.update({
    where: { id: params.overrideId },
    data: {
      revokedAt: new Date(),
      revokedByUserId: params.revokedByUserId,
    },
  });

  await db.auditLog
    .create({
      data: {
        userId: params.revokedByUserId,
        action: "PROGRESSION_OVERRIDE_REVOKED",
        entity: "ProgressionOverride",
        entityId: updated.id,
        details: JSON.stringify({
          studentId: updated.studentId,
          lessonId: updated.lessonId,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return { override: updated, revoked: true };
}

export async function listActiveOverridesForStudent(studentId: string) {
  const now = new Date();
  return db.progressionOverride.findMany({
    where: {
      studentId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: "desc" },
    include: {
      lesson: {
        select: { id: true, title: true, titleAr: true, officialCode: true },
      },
      createdBy: { select: { id: true, name: true } },
    },
  });
}

export async function listOverridesForLesson(lessonId: string) {
  return db.progressionOverride.findMany({
    where: { lessonId },
    orderBy: { createdAt: "desc" },
    include: {
      student: { select: { id: true, user: { select: { name: true } } } },
      lesson: { select: { id: true, title: true, titleAr: true } },
      createdBy: { select: { id: true, name: true } },
    },
  });
}
