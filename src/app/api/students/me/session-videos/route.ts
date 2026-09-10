// GET /api/students/me/session-videos
//
// Returns the PUBLISHED session videos of the student's own batch only.
// Access control is entirely server-side: a student of the Arabic batch can
// never see a Language-batch video, regardless of what the client requests.

import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { getEnrollment, syncStudentBatch } from "@/lib/enrollment";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { videoTrackFilter } from "@/lib/track-scope";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";

export async function GET() {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await db.student.findUnique({
    where: { userId: user.id },
    select: { id: true, batchId: true },
  });
  if (!student) return err("Student profile not found", 404);

  const enrollment = await getEnrollment(student.id);
  if (!enrollment.isEnrolled) {
    return ok({ isEnrolled: false, videos: [] });
  }

  // Lazily attach the student to the batch of their school type.
  const batchId = student.batchId || (await syncStudentBatch(student.id));
  if (!batchId) return ok({ isEnrolled: true, videos: [] });

  const videos = await db.sessionVideo.findMany({
    // Phase 12 — the batch + published authorization above is unchanged; the
    // track check is layered ON TOP of it, never in place of it. A video's
    // track IS its batch's schoolType, so this re-derives the segment from the
    // row itself: even a stale or hand-edited `Student.batchId` can no longer
    // serve the other school type's recordings.
    where: {
      batchId,
      isPublished: true,
      ...videoTrackFilter(enrollment.schoolType),
      // Phase 13 — a recording LINKED TO A SESSION that has not been opened
      // must not name that session: this payload carries
      // `lesson: { id, title, titleAr }`, so without the clause a staged
      // lesson's title (and a clickable id) reaches the student through the
      // video list. A video with no lesson link is unaffected — batch
      // recordings stand on their own publication lifecycle
      // (`SessionVideo.isPublished`), which this phase deliberately does not
      // merge into lesson progression (see the Phase 12 video contract).
      OR: [
        { lessonId: null },
        { lesson: LESSON_STUDENT_STATUS_FILTER },
      ],
    },
    orderBy: { publishedAt: "desc" },
    include: {
      media: { select: { id: true, storage: true, externalUrl: true, durationSec: true } },
      lesson: { select: { id: true, title: true, titleAr: true } },
      views: { where: { studentId: student.id }, take: 1 },
    },
    take: 100,
  });

  return ok({
    isEnrolled: true,
    threshold: VIDEO_COMPLETION_THRESHOLD,
    videos: videos.map((v) => {
      const view = v.views[0];
      return {
        id: v.id,
        title: v.title,
        titleAr: v.titleAr,
        description: v.description,
        lesson: v.lesson,
        requiredPercent: v.requiredPercent,
        publishedAt: v.publishedAt,
        // Uploaded media is served only through the authorized route.
        src:
          v.media.storage === "EXTERNAL_URL"
            ? v.media.externalUrl
            : `/api/media/${v.media.id}`,
        isExternal: v.media.storage === "EXTERNAL_URL",
        progress: {
          percent: view?.percent ?? 0,
          isCompleted: view?.isCompleted ?? false,
          watchedSec: view?.watchedSec ?? 0,
        },
      };
    }),
  });
}
