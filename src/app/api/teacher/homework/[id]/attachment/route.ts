// POST /api/teacher/homework/[id]/attachment — Phase G
//
// BUFFERED teacher assignment-attachment upload (multipart/form-data).
//
// This is the local-development fallback of the presigned teacher flow —
// the SAME pattern the lesson PDFs use: when MEDIA_BACKEND=local the
// presigned init answers PRESIGNED_UNSUPPORTED and the client drops to this
// route. It is equally valid as a small-file path on any backend
// (writePrivateFile targets the ACTIVE managed store), so nothing here is a
// second storage system: one MediaAsset contract, one private volume/bucket.
//
// Validation: role → teacher scope (homework → lesson → course) → lifecycle
// (CLOSED refused) → file admissibility through the shared homework contract
// (extension + MIME + magic bytes + 25 MB) → quota → write bytes → asset row
// → pointer update (audited post-publish).
//
// DELETE semantics are carried by PATCH /api/teacher/homework/[id] with
// `attachmentId: null` — detaching never deletes stored bytes.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile, applyRateLimit, rateLimitedResponse } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import {
  LESSON_PLACEMENT_SELECT,
  lessonPlacement,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";
import { validateHomeworkFile } from "@/lib/homework-files";
import {
  activeMediaStorageValue,
  makeStorageKey,
  sanitizeOriginalFilename,
  writePrivateFile,
} from "@/lib/media";
import { assertVolumeQuota } from "@/lib/storage-quotas";
import { extFromHomeworkFileMime } from "@/lib/homework-files";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const rl = await applyRateLimit("homeworkUpload", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const homework = await db.homework.findUnique({
    where: { id },
    include: { lesson: { select: LESSON_PLACEMENT_SELECT } },
  });
  if (!homework) return err(tApi("api.238"), 404);
  const placement = lessonPlacement(homework.lesson as ChainLesson | null);
  if (!placement || !teacherCourseIds(teacher).includes(placement.courseId)) {
    return err(tApi("api.180"), 403);
  }
  if (String(homework.lesson?.curriculumStatus ?? "").toUpperCase() === "ARCHIVED") {
    return err(tApi("api.242"), 409);
  }
  if (homework.status === "CLOSED") return err(tApi("api.354"), 409);

  const form = await req.formData().catch(() => null);
  const f = form ? form.get("file") : null;
  if (!f || typeof f === "string") return err(tApi("api.358"), 400);
  const file = f as File;

  const buf = Buffer.from(await file.arrayBuffer());
  const originalName = sanitizeOriginalFilename(file.name, "assignment.bin");
  const check = validateHomeworkFile({
    role: "TEACHER_ATTACHMENT",
    buffer: buf,
    claimedMime: file.type || null,
    originalName,
  });
  if (!check.ok) return err(tApi("api.358"), 400);

  const quota = await assertVolumeQuota(check.sizeBytes);
  if (!quota.ok) return err(tApi("api.359"), 413);

  const ext = extFromHomeworkFileMime("TEACHER_ATTACHMENT", check.mimeType) ?? check.extension;
  const key = makeStorageKey("homework-attachments", ext);
  await writePrivateFile(key, buf);

  const asset = await db.mediaAsset.create({
    data: {
      kind: "DOCUMENT",
      storage: activeMediaStorageValue(),
      storageKey: key,
      mimeType: check.mimeType,
      sizeBytes: check.sizeBytes,
      originalName: check.originalName,
      isPrivate: true,
      createdById: user.id,
    },
  });

  await db.homework.update({
    where: { id },
    data: { attachmentId: asset.id },
  });
  if (homework.status !== "DRAFT") {
    await db.auditLog
      .create({
        data: {
          userId: user.id,
          action: "HOMEWORK_UPDATED",
          entity: "Homework",
          entityId: id,
          details: JSON.stringify({ status: homework.status, fields: ["attachmentId"] }),
        },
      })
      .catch(() => {});
  }

  return ok({
    attachment: {
      id: asset.id,
      name: asset.originalName || "file",
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      downloadUrl: `/api/media/${asset.id}`,
    },
  });
}
