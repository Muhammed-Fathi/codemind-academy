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
import { normalizeSchoolType } from "@/lib/school-type";

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
      sessionVideos: {
        select: {
          id: true,
          batchId: true,
          isPublished: true,
          // Phase 12: a video's track is its batch's school type.
          batch: { select: { schoolType: true } },
        },
      },
      quizEvidence: { select: { id: true } },
      // Phase 14 — DOCUMENT assets attached to materials. Students must never
      // reach them through this route; the authorized path is
      // GET /api/materials/[id] (full 10-check contract).
      materials: { select: { id: true } },
    },
  });
  if (!asset) return err("Not found", 404);

  // External URLs are not proxied — the client uses them directly. A 404 (not
  // a 400) keeps this route from confirming that the id is a REAL asset whose
  // bytes simply live elsewhere: probing ids must never distinguish "exists
  // but external" from "does not exist".
  if (asset.storage === "EXTERNAL_URL" || !asset.storageKey) {
    return err("Not found", 404);
  }

  // ---- Authorization -------------------------------------------------------
  const isQuizEvidence = asset.quizEvidence.length > 0;
  const isDocumentMaterial = asset.materials.length > 0 || asset.kind === "DOCUMENT";
  if (isQuizEvidence) {
    // Quiz camera evidence is strictly admin-only.
    if (user.role !== "ADMIN") return err("Forbidden", 403);
    await logSecurityEvent({
      userId: user.id,
      type: "QUIZ_EVIDENCE_ACCESSED",
      detail: `mediaAssetId=${asset.id}`,
    });
  } else if (isDocumentMaterial) {
    // Phase 14: session PDFs are served ONLY via /api/materials/[id]. Guessing
    // a MediaAsset id must not bypass the material-level 10-check contract.
    if (user.role !== "ADMIN") return err("Forbidden", 403);
  } else if (asset.sessionVideos.length > 0) {
    if (user.role === "STUDENT") {
      const student = await db.student.findUnique({
        where: { userId: user.id },
        select: {
          batchId: true,
          schoolType: true,
          user: { select: { isActive: true } },
        },
      });
      // Phase 12 — batch membership AND track must both match, and the track
      // is derived server-side from the student's own schoolType, never from
      // the batch id in the URL. This closes the sticky-batchId hole at the
      // media boundary: a student still pointing at the other school type's
      // batch cannot stream its recordings.
      const studentSchoolType = normalizeSchoolType(student?.schoolType);
      const allowed =
        !!student?.batchId &&
        !!studentSchoolType &&
        asset.sessionVideos.some(
          (v) =>
            v.isPublished &&
            v.batchId === student.batchId &&
            v.batch.schoolType === studentSchoolType
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
    // Phase 20 — strict Range parsing (parity with /api/materials/[id]):
    // non-numeric / negative / out-of-range bounds are refused with 416
    // rather than producing a malformed partial response (NaN coerces to 0 in
    // `subarray`, which previously yielded a bogus 206 `bytes NaN-NaN/…`).
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const startRaw = match[1];
      const endRaw = match[2];
      const start = startRaw === "" ? 0 : Number(startRaw);
      const end = endRaw === "" ? total - 1 : Number(endRaw);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < 0 ||
        start >= total ||
        end >= total ||
        start > end
      ) {
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
