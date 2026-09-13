// PATCH  /api/admin/session-videos/[id]  — publish / unpublish / edit
// DELETE /api/admin/session-videos/[id]  — remove the publication
//
// Publishing is a single flag flip on ONE row: it instantly makes the media
// available to every eligible student of the batch. No records are copied.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { deletePrivateFile, isManagedPrivateStorage } from "@/lib/media";
import { getServerT } from "@/lib/i18n-server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const video = await db.sessionVideo.findUnique({ where: { id } });
  if (!video) return err(tApi("api.214"), 404);

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (typeof body.title === "string") data.title = body.title.trim();
  if (typeof body.titleAr === "string") data.titleAr = body.titleAr.trim();
  if (typeof body.description === "string") data.description = body.description;
  if (body.lessonId !== undefined) data.lessonId = body.lessonId || null;
  if (body.requiredPercent !== undefined)
    data.requiredPercent = Math.min(100, Math.max(50, Number(body.requiredPercent)));
  if (typeof body.isPublished === "boolean") {
    data.isPublished = body.isPublished;
    data.publishedAt = body.isPublished ? video.publishedAt || new Date() : null;
  }

  const updated = await db.sessionVideo.update({ where: { id }, data });
  return ok({ video: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const video = await db.sessionVideo.findUnique({
    where: { id },
    include: { media: true },
  });
  if (!video) return err(tApi("api.214"), 404);

  await db.sessionVideo.delete({ where: { id } });

  // Only delete the underlying media when nothing else references it.
  const stillUsed = await db.sessionVideo.count({
    where: { mediaAssetId: video.mediaAssetId },
  });
  if (stillUsed === 0) {
    // Managed private bytes — LOCAL_PRIVATE on the private volume OR S3 in the
    // R2 bucket — are removed through the SAME storage abstraction, addressed
    // by the backend the row records. ORDER IS THE SAFETY PROPERTY: the object
    // goes first, the MediaAsset row second, so a failed object delete (an S3
    // service error, a volume failure) rejects this handler and leaves the row
    // in place — the bytes keep a pointer and the delete can be retried, rather
    // than being orphaned silently.
    if (isManagedPrivateStorage(video.media.storage) && video.media.storageKey) {
      await deletePrivateFile(video.media.storageKey, video.media.storage);
    }
    await db.mediaAsset.delete({ where: { id: video.mediaAssetId } }).catch(() => {});
  }

  return ok({ ok: true });
}
