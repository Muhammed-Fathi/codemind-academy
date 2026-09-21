// PATCH  /api/admin/session-videos/[id]  — publish / unpublish / edit
// DELETE /api/admin/session-videos/[id]  — remove the publication
//
// Publishing is a single flag flip on ONE row: it instantly makes the media
// available to every eligible student of the batch. No records are copied.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { deletePrivateFile, isManagedPrivateStorage } from "@/lib/media";
import { getServerT } from "@/lib/i18n-server";
import {
  SESSION_VIDEO_LINK_ERRORS,
  SESSION_VIDEO_REQUIREMENT_ERRORS,
  parseSessionVideoRequirement,
  validateAbsentSessionLink,
  validateSessionVideoLink,
  type SessionVideoLinkCode,
  type SessionVideoRequirementCode,
} from "@/lib/session-video-link";
import { effectiveRequirementMode } from "@/lib/video-applicability";

/** Localized message + machine code, same shape as the POST route. */
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const video = await db.sessionVideo.findUnique({
    where: { id },
    // The requirement edit needs the row's storage (trackability decides
    // whether REQUIRED is even expressible); nothing else changes shape.
    include: { media: { select: { storage: true } } },
  });
  if (!video) return err(tApi("api.214"), 404);

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};
  if (typeof body.title === "string") data.title = body.title.trim();
  if (typeof body.titleAr === "string") data.titleAr = body.titleAr.trim();
  if (typeof body.description === "string") data.description = body.description;
  if (body.lessonId !== undefined) {
    // Phase A — an explicit re-link goes through the SAME academic-link
    // contract as creation: the new Lesson must exist, not be archived, and
    // fit the row's batch (one course, track fit). Invalid relationships are
    // refused, never silently accepted or corrected. Unsetting (null/empty)
    // keeps the existing manual-unlink semantics for legacy management — it
    // is not a creation path, and the UI offers it nowhere.
    const lessonIdRaw = body.lessonId;
    if (lessonIdRaw === null || lessonIdRaw === "") {
      data.lessonId = null;
    } else {
      const link = await validateSessionVideoLink(db, {
        lessonId: String(lessonIdRaw),
        batchId: video.batchId,
      });
      if (!link.ok) return sessionVideoLinkError(tApi, link.code);
      data.lessonId = link.lessonId;
    }
  }
  // A lesson re-link (or unlink) also re-runs the requirement contract:
  // the ABSENT_STUDENTS absence source is validated against the RESULTING
  // lesson, and unlinking the lesson off an ABSENT_STUDENTS row is refused
  // (ABSENT_REQUIRES_LESSON) — never a silent detach into an ungatable row.
  if (
    body.isRequiredForProgression !== undefined ||
    body.requirementMode !== undefined ||
    body.liveSessionId !== undefined ||
    body.requiredPercent !== undefined ||
    body.lessonId !== undefined
  ) {
    // The edit validates the RESULTING state through the shared requirement
    // contract: each field falls back to the stored value, so a percent-only
    // edit cannot clear requiredness and a flag-only edit keeps the stored
    // threshold. The range rule (50–100) is the pre-existing PATCH rule, now
    // shared; garbage percents are refused (422) instead of reaching Prisma.
    // An explicitly-provided mode wins over the legacy flag; when only the
    // legacy flag is sent (older clients) it still maps to ALL_STUDENTS /
    // OPTIONAL exactly as before. The MODE is always persisted alongside the
    // dual-written flag, and leaving ABSENT_STUDENTS clears the session link
    // so a stale absence source can never linger on the row.
    const resultingLessonId =
      data.lessonId !== undefined ? (data.lessonId as string | null) : video.lessonId;
    // Mode fallback when the edit carries no explicit mode: the INCOMING
    // legacy flag (when present) wins over the stored mode — a legacy
    // client's false→true flip must take, and a legacy false must clear —
    // while a flag-true write-back onto an ABSENT_STUDENTS row keeps ABSENT
    // (a legacy client that cannot express ABSENT must never silently
    // downgrade it to ALL). With no incoming flag at all (percent-only or
    // re-link edits), the stored EFFECTIVE mode is kept — the legacy flag
    // is honored, so direct-seeded flag-only rows keep gating as
    // ALL_STUDENTS instead of collapsing to OPTIONAL.
    const storedMode = effectiveRequirementMode(video);
    const incomingFlag = body.isRequiredForProgression;
    const fallbackMode =
      incomingFlag === true || incomingFlag === "true"
        ? (storedMode === "ABSENT_STUDENTS" ? "ABSENT_STUDENTS" : "ALL_STUDENTS")
        : incomingFlag === false || incomingFlag === "false"
          ? "OPTIONAL"
          : storedMode;
    const parsed = parseSessionVideoRequirement(
      {
        isRequiredForProgression:
          body.isRequiredForProgression !== undefined
            ? body.isRequiredForProgression
            : video.isRequiredForProgression,
        requirementMode:
          body.requirementMode !== undefined ? body.requirementMode : fallbackMode,
        liveSessionId:
          body.liveSessionId !== undefined ? body.liveSessionId : video.liveSessionId,
        requiredPercent:
          body.requiredPercent !== undefined ? body.requiredPercent : video.requiredPercent,
      },
      { storage: video.media.storage, lessonId: resultingLessonId }
    );
    if (!parsed.ok) return sessionVideoRequirementError(tApi, parsed.code);
    if (parsed.requirementMode === "ABSENT_STUDENTS") {
      const absentLink = await validateAbsentSessionLink(db, {
        liveSessionId: parsed.liveSessionId,
        lessonId: resultingLessonId,
        batchId: video.batchId,
      });
      if (!absentLink.ok) return sessionVideoRequirementError(tApi, absentLink.code);
    }
    data.requirementMode = parsed.requirementMode;
    data.isRequiredForProgression = parsed.isRequired;
    data.liveSessionId = parsed.liveSessionId;
    if (body.requiredPercent !== undefined) data.requiredPercent = parsed.requiredPercent;
  }
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
