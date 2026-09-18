// GET /api/media/[id]
//
// The ONLY way to read a private media asset. Bytes live outside the public
// web root under an unguessable random key, so there is no public URL at all —
// neither on the local private volume (MediaAsset.storage = LOCAL_PRIVATE) nor
// in the S3/R2 bucket (MediaAsset.storage = S3). Both are proxied:
//
//   Browser → this route (authorized) → StorageBackend → bytes
//
// No signed URL, no redirect to the object store, no credential, no bucket
// hostname ever appears in a response.
//
// Every request is authorized here:
//   * Session videos  -> admin/teacher, or a student of the owning batch when
//                        the video is published.
//   * Quiz evidence   -> ADMIN only (sensitive personal data).
// Supports HTTP Range so videos can seek. Bytes are STREAMED through the
// storage abstraction's ranged read — a large video is never buffered whole.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser, err } from "@/lib/api";
import {
  isManagedPrivateStorage,
  privateFileStat,
  readPrivateFileStream,
  storageStreamToWebResponseBody,
} from "@/lib/media";
import { logSecurityEvent } from "@/lib/security";
import { normalizeSchoolType } from "@/lib/school-type";
import { canAccessLesson } from "@/lib/session-progress";

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
          // Phase B (fix) — needed for the lesson gate in the student branch.
          lessonId: true,
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

  // External URLs are not proxied — the client uses them directly. Everything
  // this route DOES serve is a managed private object: LOCAL_PRIVATE (private
  // volume) or S3 (R2 bucket). A 404 (not a 400) keeps this route from
  // confirming that the id is a REAL asset whose bytes simply live elsewhere:
  // probing ids must never distinguish "exists but external" from "does not
  // exist". Fail-closed — an unexpected/empty storage value is refused here
  // too, never served as if it were private managed bytes.
  if (!isManagedPrivateStorage(asset.storage) || !asset.storageKey) {
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
          id: true,
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

      // Phase B (fix) — the SAME lesson authority as the Lesson page now
      // gates media bytes too. A recording of a lesson the student may not
      // open must not stream, even though its batch/track/publication
      // checks all passed:
      //
      //   * Legacy lesson-less rows (lessonId = null) keep their historical
      //     batch-publication behaviour — no lesson exists to gate on, so a
      //     legacy-only asset streams exactly as before.
      //   * If every batch/track-authorized copy of this asset is linked to
      //     a lesson, at least one of those lessons must be accessible to
      //     THIS student (`canAccessLesson` — the same verdict the lesson
      //     page, the standalone library and the heartbeat apply), or the
      //     bytes are refused.
      //
      // A media id may be shared by the audience copies of one recording, so
      // the check is per-lesson of the authorized candidates.
      const authorizedCandidates = asset.sessionVideos.filter(
        (v) =>
          v.isPublished &&
          v.batchId === student?.batchId &&
          v.batch.schoolType === studentSchoolType
      );
      const gatedLessonIds = [
        ...new Set(
          authorizedCandidates.filter((v) => v.lessonId).map((v) => v.lessonId as string),
        ),
      ];
      if (gatedLessonIds.length > 0) {
        const lessonVerdicts = await Promise.all(
          gatedLessonIds.map((lid) => canAccessLesson(student!.id, lid)),
        );
        const anyLessonAuthorized = lessonVerdicts.some((v) => v.allowed);
        const anyLessonless = authorizedCandidates.some((v) => v.lessonId === null);
        if (!anyLessonAuthorized && !anyLessonless) return err("Forbidden", 403);
      }
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
  // `asset.storage` names the backend that holds these bytes (LOCAL_PRIVATE or
  // S3); the storage abstraction does the I/O either way. Nothing below is
  // reached before the authorization verdict above.
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
  // The inclusive window to serve, or null for a full 200 response. A Range
  // header that does not parse is IGNORED (full response) exactly as before;
  // one that parses but cannot be satisfied is a 416.
  let window: { start: number; end: number } | null = null;
  // Whole-object size — only needed to validate a range and to build the 416
  // `Content-Range: bytes */TOTAL`. A plain full read skips this round trip and
  // takes the size from the streamed result instead.
  let total = 0;
  if (range) {
    // Phase 20 — strict Range parsing (parity with /api/materials/[id]):
    // non-numeric / negative / out-of-range bounds are refused with 416
    // rather than producing a malformed partial response.
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const stat = await privateFileStat(asset.storageKey, asset.storage);
      if (!stat) return err("Not found", 404);
      total = stat.size;
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
      window = { start, end };
    }
  }

  // STREAM the object (or exactly the requested window) instead of buffering
  // it: a session video may be hundreds of megabytes, and the ranged read is
  // resolved identically by every backend, so 206 bookkeeping does not depend
  // on where the bytes live.
  let result;
  try {
    result = await readPrivateFileStream(
      asset.storageKey,
      window ?? undefined,
      asset.storage
    );
  } catch (e) {
    // The window was validated against `total` above, so a RangeError here
    // means the object changed size underneath us — still an unsatisfiable
    // range, answered with the same 416 shape.
    if (e instanceof RangeError) {
      return new NextResponse(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
      });
    }
    throw e;
  }
  // Missing object → the same non-oracle 404 as an unknown id.
  if (!result) return err("Not found", 404);

  if (window) {
    return new NextResponse(storageStreamToWebResponseBody(result.stream), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${result.start}-${result.end}/${result.size}`,
        "Content-Length": String(result.contentLength),
      },
    });
  }

  return new NextResponse(storageStreamToWebResponseBody(result.stream), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(result.size) },
  });
}
