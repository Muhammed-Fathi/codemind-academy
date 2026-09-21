// Admin session-video management.
//   GET  /api/admin/session-videos?batchId=...
//   POST /api/admin/session-videos   (multipart OR json)
//
// Two publishing methods are supported:
//   1. Uploaded video file  -> stored ONCE in private storage as a MediaAsset,
//      in whichever managed private backend is ACTIVE:
//      MEDIA_BACKEND=local → storage=LOCAL_PRIVATE (private volume),
//      MEDIA_BACKEND=s3    → storage=S3 (Cloudflare R2 bucket).
//      Either way it is served only by the authorized /api/media/[id] proxy.
//   2. Video URL            -> stored as a MediaAsset with storage=EXTERNAL_URL.
//      The URL must satisfy the external video contract in
//      `src/lib/video-url.ts`: a DIRECT https media file, a YouTube link, or a
//      Vimeo link. It is NORMALISED before it is stored, so what the student
//      player receives is always a form it can actually render. A URL outside
//      that contract is rejected HERE with a specific reason — it is never
//      stored and never reaches a student as an unplayable player.
//
// The media is stored once and associated with the batch. Publishing makes it
// available to every eligible student of that batch — no per-student copies.
//
// ACADEMIC IDENTITY (Phase A): a NEW video always carries `lessonId` — the
// canonical Lesson IS the academic session, `batchId` is the audience/track.
// POST validates the (lesson, batch) pair with the shared
// `validateSessionVideoLink` contract BEFORE any media is written:
// lesson required → exists → not archived → batch exists → same course →
// track fit. The same contract guards the presigned flow
// (src/lib/media-upload.ts) and the explicit re-link in the PATCH route
// (src/app/api/admin/session-videos/[id]/route.ts), so every creation path
// produces the same relationship. Existing legacy rows with `lessonId = null`
// are untouched: readable and deletable, never migrated.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import {
  activeMediaStorageValue,
  MAX_VIDEO_BYTES,
  extFromMime,
  isAllowedVideoMime,
  makeStorageKey,
  writePrivateFile,
} from "@/lib/media";
import { normalizeExternalVideoUrl } from "@/lib/video-url";
import { assertVolumeQuota } from "@/lib/storage-quotas";
import { getServerT } from "@/lib/i18n-server";
import {
  SESSION_VIDEO_LINK_ERRORS,
  SESSION_VIDEO_REQUIREMENT_ERRORS,
  parseSessionVideoRequirement,
  validateSessionVideoLink,
  type SessionVideoLinkCode,
  type SessionVideoRequirementCode,
} from "@/lib/session-video-link";

/**
 * One response shape for every academic-link refusal: a LOCALIZED admin-facing
 * message plus the MACHINE-READABLE contract code, so the UI can both show a
 * human reason and branch on the cause.
 */
function sessionVideoLinkError(
  tApi: (key: string) => string,
  code: SessionVideoLinkCode
): NextResponse {
  const meta = SESSION_VIDEO_LINK_ERRORS[code];
  return NextResponse.json({ error: tApi(meta.i18n), code }, { status: meta.status });
}

/**
 * One response shape for every progression-requirement refusal: a LOCALIZED
 * admin-facing message plus the MACHINE-READABLE contract code (422).
 */
function sessionVideoRequirementError(
  tApi: (key: string) => string,
  code: SessionVideoRequirementCode
): NextResponse {
  const meta = SESSION_VIDEO_REQUIREMENT_ERRORS[code];
  return NextResponse.json({ error: tApi(meta.i18n), code }, { status: meta.status });
}

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const batchId = url.searchParams.get("batchId");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10))
  );

  const where = batchId ? { batchId } : {};
  const [total, videos] = await Promise.all([
    db.sessionVideo.count({ where }),
    db.sessionVideo.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        batch: { select: { id: true, name: true, nameAr: true, schoolType: true } },
        // Academic ownership for the list (Phase A): the lesson's code/title
        // plus its unit, so the admin sees "Lesson 1-1 — Variables / Unit 1"
        // instead of a raw id. Legacy rows carry lesson = null.
        lesson: {
          select: {
            id: true,
            title: true,
            titleAr: true,
            officialCode: true,
            unit: { select: { id: true, title: true, titleAr: true, order: true } },
          },
        },
        media: {
          select: { id: true, storage: true, externalUrl: true, durationSec: true, mimeType: true, sizeBytes: true },
        },
        _count: { select: { views: true } },
      },
    }),
  ]);

  return ok({
    videos: videos.map((v) => ({
      id: v.id,
      title: v.title,
      titleAr: v.titleAr,
      description: v.description,
      batch: v.batch,
      lesson: v.lesson,
      requiredPercent: v.requiredPercent,
      isRequiredForProgression: v.isRequiredForProgression,
      isPublished: v.isPublished,
      publishedAt: v.publishedAt,
      // Uploaded files are NEVER exposed as a direct path — only via the
      // authorized streaming route.
      source: v.media.storage === "EXTERNAL_URL" ? "URL" : "UPLOAD",
      externalUrl: v.media.storage === "EXTERNAL_URL" ? v.media.externalUrl : null,
      streamUrl: v.media.storage === "EXTERNAL_URL" ? null : `/api/media/${v.media.id}`,
      durationSec: v.media.durationSec,
      viewers: v._count.views,
      createdAt: v.createdAt,
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
    },
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const contentType = req.headers.get("content-type") || "";
  let batchId = "";
  let lessonId: string | null = null;
  let title = "";
  let titleAr = "";
  let description: string | null = null;
  let publish = false;
  let externalUrl: string | null = null;
  let file: File | null = null;
  let requiredFlagRaw: unknown = undefined;
  let requiredPercentRaw: unknown = undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    batchId = String(form.get("batchId") || "");
    lessonId = form.get("lessonId") ? String(form.get("lessonId")) : null;
    title = String(form.get("title") || "").trim();
    titleAr = String(form.get("titleAr") || title).trim();
    description = form.get("description") ? String(form.get("description")) : null;
    publish = String(form.get("publish") || "") === "true";
    externalUrl = form.get("videoUrl") ? String(form.get("videoUrl")).trim() : null;
    requiredFlagRaw = form.get("isRequiredForProgression");
    requiredPercentRaw = form.get("requiredPercent");
    const f = form.get("file");
    if (f && typeof f !== "string") file = f as File;
  } else {
    const body = await req.json().catch(() => ({}));
    batchId = String(body.batchId || "");
    lessonId = body.lessonId ? String(body.lessonId) : null;
    title = String(body.title || "").trim();
    titleAr = String(body.titleAr || title).trim();
    description = body.description ? String(body.description) : null;
    publish = body.publish === true;
    externalUrl = body.videoUrl ? String(body.videoUrl).trim() : null;
    requiredFlagRaw = body.isRequiredForProgression;
    requiredPercentRaw = body.requiredPercent;
  }

  if (!title) return err(tApi("api.187"), 400);

  // Phase A — academic ownership: a NEW session video must belong to a valid
  // Lesson × Batch pair. The SAME shared validator the presigned init/complete
  // use enforces the whole contract here (lesson present, exists, not
  // archived, batch exists, one course, track fit), so the buffered file
  // path and the external-URL path can never create a lesson-less or
  // cross-course / cross-track video. The validated pair (below) is what is
  // persisted — client values are never corrected or guessed.
  const link = await validateSessionVideoLink(db, { lessonId, batchId });
  if (!link.ok) return sessionVideoLinkError(tApi, link.code);

  if (!file && !externalUrl) return err(tApi("api.219"), 400);

  // --- Create the MediaAsset ONCE -----------------------------------------
  let mediaAssetId: string;
  // Set by exactly one branch below (both validate through the shared
  // requirement contract before anything is written).
  let requirement = { isRequired: false, requiredPercent: 95 };

  if (file) {
    if (file.size > MAX_VIDEO_BYTES) return err(tApi("api.215"), 413);
    const mime = file.type || "application/octet-stream";
    if (!isAllowedVideoMime(mime)) return err(tApi("api.216"), 415);

    const storageKey = makeStorageKey("session-videos", extFromMime(mime));
    const buffer = Buffer.from(await file.arrayBuffer());
    const originalName = (file as { name?: string }).name?.slice(0, 200) || null;
    // WHERE these bytes go is decided by the ACTIVE backend selector — never
    // inferred from the key/path: LOCAL_PRIVATE under MEDIA_BACKEND=local, S3
    // under MEDIA_BACKEND=s3. Resolved BEFORE the write so an unsupported
    // MEDIA_BACKEND fails closed with nothing written anywhere.
    const storage = activeMediaStorageValue();
    // Progression requirement, validated BEFORE any byte is written: an
    // uploaded (managed-storage) video may be REQUIRED; the threshold keeps
    // the existing 50–100 range rule. Size/mime precedence above is kept.
    const fileRequirement = parseSessionVideoRequirement(
      { isRequiredForProgression: requiredFlagRaw, requiredPercent: requiredPercentRaw },
      { storage }
    );
    if (!fileRequirement.ok) return sessionVideoRequirementError(tApi, fileRequirement.code);
    requirement = { isRequired: fileRequirement.isRequired, requiredPercent: fileRequirement.requiredPercent };
    // Phase 21 — volume quota, checked BEFORE any byte is written. No-op
    // unless the operator sets MEDIA_QUOTA_BYTES.
    const quota = await assertVolumeQuota(buffer.length);
    if (!quota.ok) return err("Media storage quota exceeded", 413);
    await writePrivateFile(storageKey, buffer, { mimeType: mime, originalName });

    const asset = await db.mediaAsset.create({
      data: {
        kind: "VIDEO",
        // Matches the backend that just took the bytes.
        storage,
        storageKey,
        mimeType: mime,
        sizeBytes: buffer.length,
        originalName,
        isPrivate: true,
        createdById: user?.id || null,
      },
    });
    mediaAssetId = asset.id;
  } else {
    // External video contract (src/lib/video-url.ts). Anything the student
    // player cannot render is refused HERE, before a MediaAsset exists, so an
    // admin can never stage a video that silently shows a black player.
    const external = normalizeExternalVideoUrl(externalUrl);
    if (!external.ok) {
      return err(
        tApi(
          external.code === "MALFORMED"
            ? "api.217"
            : external.code === "INSECURE_PROTOCOL"
              ? "api.303"
              : external.code === "UNSAFE_HOST"
                ? "api.304"
                : "api.305"
        ),
        400
      );
    }
    // Progression requirement: an EXTERNAL_URL row is untrackable (no
    // reliable server watch %), so REQUIRED is refused here — never stored
    // as required, never silently demoted either. The admin must choose.
    const urlRequirement = parseSessionVideoRequirement(
      { isRequiredForProgression: requiredFlagRaw, requiredPercent: requiredPercentRaw },
      { storage: "EXTERNAL_URL" }
    );
    if (!urlRequirement.ok) return sessionVideoRequirementError(tApi, urlRequirement.code);
    requirement = { isRequired: urlRequirement.isRequired, requiredPercent: urlRequirement.requiredPercent };
    const asset = await db.mediaAsset.create({
      data: {
        kind: "VIDEO",
        storage: "EXTERNAL_URL",
        // Store the CANONICAL form (YouTube/Vimeo become their embed URL, a
        // direct file link is kept verbatim) so the student player renders
        // exactly what was validated — never the raw, possibly unplayable,
        // link the admin pasted.
        externalUrl: external.url,
        // mimeType stays unset for EXTERNAL_URL assets, exactly as before:
        // nothing downstream reads it for external media, and inventing a
        // value here would risk a reader mistaking it for a real content type.
        isPrivate: false,
        createdById: user?.id || null,
      },
    });
    mediaAssetId = asset.id;
  }

  // Persist EXACTLY the validated pair — the row's academic identity is the
  // Lesson (canonical session) plus the Batch (audience), never a guess.
  const video = await db.sessionVideo.create({
    data: {
      batchId: link.batchId,
      lessonId: link.lessonId,
      mediaAssetId,
      title,
      titleAr,
      description,
      isRequiredForProgression: requirement.isRequired,
      requiredPercent: requirement.requiredPercent,
      isPublished: publish,
      publishedAt: publish ? new Date() : null,
    },
  });

  return ok({ video });
}
