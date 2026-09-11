// POST   /api/admin/lessons/[id]/materials  — upload / replace a session PDF
// GET    /api/admin/lessons/[id]/materials  — list materials for a lesson (admin)
// DELETE /api/admin/lessons/[id]/materials?materialId=… — deactivate a material
//
// Phase 14. Multipart PDF → private MediaAsset(DOCUMENT, LOCAL_PRIVATE) +
// Material(ADMIN_UPLOADED). Never writes Lesson.pdfUrl. Never trusts a
// client-supplied storageKey, filename, or Content-Type alone.
//
// Validation (MIME allow-list, extension, magic bytes `%PDF-`, size cap) lives
// in `src/lib/media.ts`. Authorization is ADMIN-only. Track scope defaults to
// the lesson's own trackScope when the form omits it.
//
// Replace semantics: one active ADMIN_UPLOADED PDF per (lesson × trackScope).
// A new upload deactivates the previous active row and reference-count-cleans
// the prior MediaAsset when nothing else still points at it.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  ok,
  err,
  requireRole,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import {
  uploadLessonPdfMaterial,
  deactivateMaterial,
  buildMaterialDescriptors,
  parseMaterialTrackScopeInput,
  releaseDetachedAssets,
} from "@/lib/session-materials";
import { MAX_PDF_BYTES } from "@/lib/media";
import { getServerT } from "@/lib/i18n-server";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id: lessonId } = await params;
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      title: true,
      titleAr: true,
      trackScope: true,
      status: true,
      pdfUrl: true,
      materials: {
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          title: true,
          kind: true,
          trackScope: true,
          isActive: true,
          mediaAssetId: true,
          createdAt: true,
          updatedAt: true,
          media: {
            select: {
              id: true,
              mimeType: true,
              sizeBytes: true,
              originalName: true,
              storage: true,
              isPrivate: true,
              kind: true,
            },
          },
        },
      },
    },
  });
  if (!lesson) return err("Lesson not found", 404);

  // Admin list: every material (active + inactive). Descriptors never expose
  // storageKey. storageKey is deliberately absent from the select above.
  const materials = lesson.materials.map((m) => ({
    id: m.id,
    title: m.title,
    kind: m.kind,
    trackScope: m.trackScope,
    isActive: m.isActive,
    mediaAssetId: m.mediaAssetId,
    downloadUrl: m.isActive && m.mediaAssetId ? `/api/materials/${m.id}` : null,
    mimeType: m.media?.mimeType ?? null,
    sizeBytes: m.media?.sizeBytes ?? null,
    originalName: m.media?.originalName ?? null,
    storage: m.media?.storage ?? null,
    isPrivate: m.media?.isPrivate ?? null,
    mediaKind: m.media?.kind ?? null,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }));

  return ok({
    lessonId: lesson.id,
    trackScope: lesson.trackScope,
    status: lesson.status,
    // Legacy read-only: reported so an admin can see what still depends on it.
    // Never written by this route.
    legacyPdfUrl: lesson.pdfUrl,
    materials,
    // Active-only safe descriptors (same shape students will see).
    active: buildMaterialDescriptors({
      materials: lesson.materials.filter((m) => m.isActive),
      legacyPdfUrl: null, // admin list does not invent legacy descriptors here
      includeProtected: true,
    }),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  // Phase 20 — PDF upload writes a private file + DB rows; rate limit before
  // any bytes are read so upload flooding is bounded per admin.
  const rl = await applyRateLimit("pdfUpload", user?.id ?? "anonymous-admin");
  if (!rl.allowed) return rateLimitedResponse(rl);

  const { id: lessonId } = await params;

  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return err("multipart/form-data required", 400);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return err("Malformed multipart body", 400);
  }

  const fileField = form.get("file") ?? form.get("pdf") ?? form.get("material");
  if (!fileField || typeof fileField === "string") {
    return err("PDF file is required (field: file)", 400);
  }
  const file = fileField as File;

  const title = form.get("title") ? String(form.get("title")) : null;
  const trackScopeRaw = form.get("trackScope");
  const scopeParse = parseMaterialTrackScopeInput(
    trackScopeRaw === null ? undefined : String(trackScopeRaw)
  );
  if (!scopeParse.ok) {
    return err("trackScope must be SHARED, ARABIC, or LANGUAGE", 400);
  }

  // Hard cap before buffering the whole file into memory when possible.
  // `file.size` is the browser-declared size; we still re-check after read.
  if (typeof file.size === "number" && file.size > MAX_PDF_BYTES) {
    return err(tApi("api.215"), 413);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return err("Failed to read uploaded file", 400);
  }

  const result = await uploadLessonPdfMaterial({
    lessonId,
    buffer,
    claimedMime: file.type || null,
    originalName: (file as { name?: string }).name || "document.pdf",
    title,
    trackScope: scopeParse.specified ? scopeParse.value : undefined,
    actorUserId: user?.id ?? null,
  });

  if (!result.ok) {
    if (result.code === "LESSON_NOT_FOUND") return err(result.message, 404);
    if (result.code === "LESSON_ARCHIVED") return err(result.message, 409);
    if (result.code === "INVALID_TRACK_SCOPE") return err(result.message, 400);
    // VALIDATION_FAILED — map size to 413, the rest to 415/400.
    const vCode = result.validation && !result.validation.ok
      ? result.validation.code
      : null;
    if (vCode === "TOO_LARGE") return err(result.message, 413);
    if (vCode === "MIME_REJECTED" || vCode === "MAGIC_REJECTED") {
      return err(result.message, 415);
    }
    return err(result.message, 400);
  }

  // Audit (best-effort) — never fail the upload because the audit row did.
  if (user?.id) {
    await db.auditLog
      .create({
        data: {
          userId: user.id,
          action: "LESSON_MATERIAL_UPLOAD",
          entity: "Material",
          entityId: result.material.id,
          details: JSON.stringify({
            lessonId,
            materialId: result.material.id,
            mediaAssetId: result.material.mediaAssetId,
            trackScope: result.material.trackScope,
            sizeBytes: result.material.sizeBytes,
            replaced: result.replaced.map((r) => r.materialId),
            cleanedUpAssets: result.cleanedUpAssets,
          }).slice(0, 1000),
        },
      })
      .catch(() => undefined);
  }

  return ok({
    material: result.material,
    replaced: result.replaced,
    cleanedUpAssets: result.cleanedUpAssets,
    // Explicit contract marker for tests and operators.
    pdfUrlWritten: false,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const { id: lessonId } = await params;
  const url = new URL(req.url);
  const materialId = url.searchParams.get("materialId");
  if (!materialId) return err("materialId is required", 400);

  // Ownership: the material must belong to this lesson.
  const material = await db.material.findUnique({
    where: { id: materialId },
    select: { id: true, lessonId: true, isActive: true, mediaAssetId: true },
  });
  if (!material || material.lessonId !== lessonId) {
    return err("Material not found", 404);
  }

  const result = await deactivateMaterial(materialId);
  if (!result.ok) return err(result.message, 404);

  // After deactivate, release the asset if nothing else references it.
  // deactivateMaterial already attempts cleanup while the FK still points;
  // detach + re-clean so bytes can actually go when this was the last ref.
  let cleanedUpAsset: string | null = result.cleanedUpAsset;
  if (!cleanedUpAsset && material.mediaAssetId) {
    const cleaned = await releaseDetachedAssets([material.mediaAssetId]);
    cleanedUpAsset = cleaned[0] ?? null;
  }

  if (user?.id) {
    await db.auditLog
      .create({
        data: {
          userId: user.id,
          action: "LESSON_MATERIAL_DEACTIVATE",
          entity: "Material",
          entityId: materialId,
          details: JSON.stringify({
            lessonId,
            materialId,
            cleanedUpAsset,
          }).slice(0, 1000),
        },
      })
      .catch(() => undefined);
  }

  return ok({ ok: true, materialId, cleanedUpAsset });
}
