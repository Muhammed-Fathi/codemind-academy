// Teacher-safe Session Materials (Phase E).
//
//   GET    /api/teacher/sessions/[id]/materials            — list + legacy mirror
//   POST   /api/teacher/sessions/[id]/materials            — upload a PDF
//   DELETE /api/teacher/sessions/[id]/materials?materialId — deactivate
//
// WHY THIS IS NOT THE ADMIN ROUTE WITH A WIDER ROLE
//   Phase 14's material routes are deliberately ADMIN-only: their replace
//   semantics deactivate ANY prior active material of the same
//   (lesson × trackScope), which is correct for the administrator who owns
//   the staging surface. A teacher gets this parallel route instead, whose
//   every write goes through `src/lib/teacher-sessions.ts`:
//
//     authenticated → TEACHER role → own courses (Group.courseId, never the
//     request) → `loadOwnedLesson` (canonical chain first) → not ARCHIVED →
//     track scope contained by the LESSON's scope → MANAGE-OWN:
//       · upload refuses (409) when an ACTIVE material of the same scope is
//         owned by someone else (typically the admin) — never a silent
//         overwrite;
//       · deactivate touches only rows whose MediaAsset proves the teacher
//         uploaded them (createdById === the authenticated teacher's user);
//         unproven or foreign rows answer 403.
//
//   Bytes, MIME/magic validation, storage keys, quotas, reference-counted
//   cleanup and downloads stay Phase 14 exactly; this file creates no new
//   storage path and never writes `Lesson.pdfUrl`.

import { NextRequest } from "next/server";
import { getServerT } from "@/lib/i18n-server";
import { db } from "@/lib/db";
import {
  ok,
  err,
  requireUser,
  getTeacherProfile,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import { MAX_PDF_BYTES } from "@/lib/media";
import {
  TEACHER_LIMITS,
  boundedText,
  loadOwnedLesson,
  teacherCourseIds,
} from "@/lib/teacher-content";
import {
  isUsableLegacyPdfUrl,
  parseMaterialTrackScopeInput,
} from "@/lib/session-materials";
import {
  teacherUploadLessonPdfMaterial,
  teacherDeactivateLessonMaterial,
} from "@/lib/teacher-sessions";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id: lessonId } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const owned = await loadOwnedLesson(lessonId, teacherCourseIds(teacher));
  if (!owned.ok) {
    return err(
      owned.status === 403 ? tApi("api.180") : tApi("api.179"),
      owned.status
    );
  }

  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
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
          createdAt: true,
          mediaAssetId: true,
          media: {
            select: {
              mimeType: true,
              sizeBytes: true,
              originalName: true,
              createdById: true,
            },
          },
        },
      },
    },
  });
  if (!lesson) return err(tApi("api.179"), 404);

  return ok({
    lessonId: lesson.id,
    trackScope: lesson.trackScope,
    status: lesson.status,
    // Read-only legacy mirror, reported exactly like the admin route does.
    legacyPdfUrl: isUsableLegacyPdfUrl(lesson.pdfUrl) ? lesson.pdfUrl : null,
    materials: lesson.materials.map((m) => ({
      id: m.id,
      title: m.title,
      kind: m.kind,
      trackScope: m.trackScope,
      isActive: m.isActive,
      // Phase E manage-own flag (own = teacher may deactivate it).
      own: !!m.media?.createdById && m.media.createdById === user.id,
      downloadUrl: m.isActive && m.mediaAssetId ? `/api/materials/${m.id}` : null,
      mimeType: m.media?.mimeType ?? null,
      sizeBytes: m.media?.sizeBytes ?? null,
      originalName: m.media?.originalName ?? null,
      createdAt: m.createdAt,
    })),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id: lessonId } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  // Same flooding bound as the admin upload, keyed to the teacher's id.
  const rl = await applyRateLimit("pdfUpload", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

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

  // Title is bounded BEFORE anything heavy runs — the same edge contract as
  // every other teacher write (Phase 18 limits).
  const titleIn = boundedText(form.get("title"), TEACHER_LIMITS.TITLE_MAX);
  if (!titleIn.ok) return err(tApi("api.187"), 400);

  const trackScopeRaw = form.get("trackScope");
  const scopeParse = parseMaterialTrackScopeInput(
    trackScopeRaw === null ? undefined : String(trackScopeRaw)
  );
  if (!scopeParse.ok) {
    return err("trackScope must be SHARED, ARABIC, or LANGUAGE", 400);
  }

  // Browser-declared size pre-check; the bytes are re-validated after read.
  if (typeof file.size === "number" && file.size > MAX_PDF_BYTES) {
    return err(tApi("api.215"), 413);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return err("Failed to read uploaded file", 400);
  }

  const result = await teacherUploadLessonPdfMaterial({
    lessonId,
    userId: user.id,
    courseIds: teacherCourseIds(teacher),
    buffer,
    claimedMime: file.type || null,
    originalName: (file as { name?: string }).name || "document.pdf",
    title: titleIn.value,
    trackScope: scopeParse.specified ? scopeParse.value : undefined,
  });

  if (!result.ok) {
    if (result.code === "LESSON_NOT_FOUND") return err(tApi("api.179"), result.status);
    if (result.code === "NOT_OWNED") return err(tApi("api.180"), result.status);
    if (result.code === "LESSON_ARCHIVED") return err(tApi("api.242"), result.status);
    if (result.code === "INVALID_TRACK_SCOPE") return err(tApi("api.228"), result.status);
    if (result.code === "OUT_OF_LESSON_SCOPE") return err(tApi("api.243"), result.status);
    if (result.code === "FOREIGN_ACTIVE") return err(tApi("api.318"), result.status);
    if (result.code === "QUOTA_EXCEEDED") return err(result.message, result.status);
    // VALIDATION_FAILED — the service already mapped TOO_LARGE→413 and
    // MIME/MAGIC→415; localize the message at the edge where we can.
    const vCode =
      result.validation && typeof result.validation === "object"
        ? (result.validation as { code?: string }).code
        : null;
    if (vCode === "TOO_LARGE") return err(tApi("api.215"), 413);
    if (vCode === "MIME_REJECTED" || vCode === "MAGIC_REJECTED") {
      return err(tApi("api.216"), 415);
    }
    return err(result.message, result.status);
  }

  return ok({
    material: result.material,
    replaced: result.replaced,
    cleanedUpAssets: result.cleanedUpAssets,
    // Explicit contract marker, identical to the admin route's promise.
    pdfUrlWritten: false,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id: lessonId } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const url = new URL(req.url);
  const materialId = url.searchParams.get("materialId");
  if (!materialId) return err("materialId is required", 400);

  // The URL's lessonId must be the material's own lesson: refuse a
  // cross-lesson pairing BEFORE any write (a mismatched pair is a 404, not a
  // deletion of a real row through a confusing URL).
  const pairing = await db.material.findUnique({
    where: { id: materialId },
    select: { lessonId: true },
  });
  if (!pairing || pairing.lessonId !== lessonId) {
    return err(tApi("api.179"), 404);
  }

  const result = await teacherDeactivateLessonMaterial({
    materialId,
    userId: user.id,
    courseIds: teacherCourseIds(teacher),
  });
  if (!result.ok) {
    if (result.code === "MATERIAL_NOT_FOUND" || result.code === "LESSON_NOT_FOUND") {
      return err(tApi("api.179"), result.status);
    }
    if (result.code === "NOT_OWNED_LESSON") return err(tApi("api.180"), result.status);
    return err(tApi("api.319"), result.status);
  }

  return ok({ deactivated: true, materialId, cleanedUpAsset: result.cleanedUpAsset });
}
