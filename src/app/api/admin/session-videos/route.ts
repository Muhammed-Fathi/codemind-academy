// Admin session-video management.
//   GET  /api/admin/session-videos?batchId=...
//   POST /api/admin/session-videos   (multipart OR json)
//
// Two publishing methods are supported:
//   1. Uploaded video file  -> stored ONCE in private storage as a MediaAsset.
//   2. Video URL            -> stored as a MediaAsset with storage=EXTERNAL_URL.
//
// The media is stored once and associated with the batch. Publishing makes it
// available to every eligible student of that batch — no per-student copies.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import {
  MAX_VIDEO_BYTES,
  extFromMime,
  isAllowedVideoMime,
  isSafeExternalUrl,
  makeStorageKey,
  writePrivateFile,
} from "@/lib/media";
import { getServerT } from "@/lib/i18n-server";

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
        lesson: { select: { id: true, title: true, titleAr: true } },
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

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    batchId = String(form.get("batchId") || "");
    lessonId = form.get("lessonId") ? String(form.get("lessonId")) : null;
    title = String(form.get("title") || "").trim();
    titleAr = String(form.get("titleAr") || title).trim();
    description = form.get("description") ? String(form.get("description")) : null;
    publish = String(form.get("publish") || "") === "true";
    externalUrl = form.get("videoUrl") ? String(form.get("videoUrl")).trim() : null;
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
  }

  if (!title) return err(tApi("api.187"), 400);

  const batch = await db.batch.findUnique({ where: { id: batchId } });
  if (!batch) return err(tApi("api.218"), 404);

  if (!file && !externalUrl) return err(tApi("api.219"), 400);

  // --- Create the MediaAsset ONCE -----------------------------------------
  let mediaAssetId: string;

  if (file) {
    if (file.size > MAX_VIDEO_BYTES) return err(tApi("api.215"), 413);
    const mime = file.type || "application/octet-stream";
    if (!isAllowedVideoMime(mime)) return err(tApi("api.216"), 415);

    const storageKey = makeStorageKey("session-videos", extFromMime(mime));
    const buffer = Buffer.from(await file.arrayBuffer());
    await writePrivateFile(storageKey, buffer);

    const asset = await db.mediaAsset.create({
      data: {
        kind: "VIDEO",
        storage: "LOCAL_PRIVATE",
        storageKey,
        mimeType: mime,
        sizeBytes: buffer.length,
        originalName: (file as any).name?.slice(0, 200) || null,
        isPrivate: true,
        createdById: user?.id || null,
      },
    });
    mediaAssetId = asset.id;
  } else {
    if (!isSafeExternalUrl(externalUrl!)) return err(tApi("api.217"), 400);
    const asset = await db.mediaAsset.create({
      data: {
        kind: "VIDEO",
        storage: "EXTERNAL_URL",
        externalUrl: externalUrl,
        isPrivate: false,
        createdById: user?.id || null,
      },
    });
    mediaAssetId = asset.id;
  }

  const video = await db.sessionVideo.create({
    data: {
      batchId,
      lessonId,
      mediaAssetId,
      title,
      titleAr,
      description,
      isPublished: publish,
      publishedAt: publish ? new Date() : null,
    },
  });

  return ok({ video });
}
