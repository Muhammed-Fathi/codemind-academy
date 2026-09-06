// GET /api/media/[id]
//
// The ONLY way to read a private media asset. Files live outside the public
// web root under an unguessable random key, so there is no public URL at all.
// Every request is authorized here:
//   * Session videos  -> admin/teacher, or a student of the owning batch when
//                        the video is published.
//   * Quiz evidence   -> ADMIN only (sensitive personal data).
// Supports HTTP Range so videos can seek.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, err } from "@/lib/api";
import { readPrivateFile, privateFileStat } from "@/lib/media";
import { logSecurityEvent } from "@/lib/security";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const asset = await db.mediaAsset.findUnique({
    where: { id },
    include: {
      sessionVideos: { select: { id: true, batchId: true, isPublished: true } },
      quizEvidence: { select: { id: true } },
    },
  });
  if (!asset) return err("Not found", 404);

  // External URLs are not proxied — the client uses them directly.
  if (asset.storage === "EXTERNAL_URL" || !asset.storageKey) {
    return err("Not a stored asset", 400);
  }

  // ---- Authorization -------------------------------------------------------
  const isQuizEvidence = asset.quizEvidence.length > 0;
  if (isQuizEvidence) {
    // Quiz camera evidence is strictly admin-only.
    if (user.role !== "ADMIN") return err("Forbidden", 403);
    await logSecurityEvent({
      userId: user.id,
      type: "QUIZ_EVIDENCE_ACCESSED",
      detail: `mediaAssetId=${asset.id}`,
    });
  } else if (asset.sessionVideos.length > 0) {
    if (user.role === "STUDENT") {
      const student = await db.student.findUnique({
        where: { userId: user.id },
        select: { batchId: true, user: { select: { isActive: true } } },
      });
      const allowed =
        !!student?.batchId &&
        asset.sessionVideos.some(
          (v) => v.isPublished && v.batchId === student.batchId
        );
      if (!allowed) return err("Forbidden", 403);
    } else if (user.role === "PARENT") {
      // Parents do not stream lesson media.
      return err("Forbidden", 403);
    }
    // ADMIN and TEACHER may always review session media.
  } else if (user.role !== "ADMIN") {
    // Orphan/unreferenced private asset — admin only.
    return err("Forbidden", 403);
  }

  // ---- Serve (with Range support) -----------------------------------------
  const stat = await privateFileStat(asset.storageKey);
  if (!stat) return err("Not found", 404);

  const buffer = await readPrivateFile(asset.storageKey).catch(() => null);
  if (!buffer) return err("Not found", 404);

  const total = buffer.length;
  const contentType = asset.mimeType || "application/octet-stream";
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    // Sensitive media must never be cached by shared caches.
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  };

  const range = req.headers.get("range");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        return new NextResponse(null, {
          status: 416,
          headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
        });
      }
      const chunk = buffer.subarray(start, end + 1);
      return new NextResponse(new Uint8Array(chunk), {
        status: 206,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(chunk.length),
        },
      });
    }
  }

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) },
  });
}
