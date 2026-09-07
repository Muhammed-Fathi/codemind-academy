// GET /api/students/me/session-videos
//
// Returns the PUBLISHED session videos of the student's own batch only.
// Access control is entirely server-side: a student of the Arabic batch can
// never see a Language-batch video, regardless of what the client requests.
//
// SECURITY: batch membership alone is NOT sufficient. A video attached to a
// lesson the student has not unlocked yet must not be listed or streamable,
// otherwise the whole point of sequential progression collapses — a student
// could watch Session 8 on day one. Videos with no lesson binding (general
// batch announcements) remain visible, since they gate nothing.

import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { getEnrollment, syncStudentBatch } from "@/lib/enrollment";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { getCourseSessionProgress } from "@/lib/session-progress";

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
    where: { batchId, isPublished: true },
    orderBy: { publishedAt: "desc" },
    include: {
      media: { select: { id: true, storage: true, externalUrl: true, durationSec: true } },
      lesson: { select: { id: true, title: true, titleAr: true } },
      views: { where: { studentId: student.id }, take: 1 },
    },
    take: 100,
  });

  // Drop videos bound to a still-locked session.
  const unlocked = new Set<string>();
  if (enrollment.courseId) {
    const progress = await getCourseSessionProgress(
      student.id,
      enrollment.courseId
    );
    for (const row of progress.sessions) {
      if (row.unlocked) unlocked.add(row.lessonId);
    }
  }
  const visible = videos.filter((v) => !v.lessonId || unlocked.has(v.lessonId));

  return ok({
    isEnrolled: true,
    threshold: VIDEO_COMPLETION_THRESHOLD,
    videos: visible.map((v) => {
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
