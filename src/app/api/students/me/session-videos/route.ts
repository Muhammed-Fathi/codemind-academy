// GET /api/students/me/session-videos[?lessonId=...]
//
// Returns the PUBLISHED session videos of the student's own batch only.
// Access control is entirely server-side: a student of the Arabic batch can
// never see a Language-batch video, regardless of what the client requests.
//
// Phase 16 — the optional `lessonId` narrows the list to the recordings linked
// to one session, so the unified lesson page can embed its recordings without
// a second authorization path. It is a pure NARROWING filter: every clause
// below still applies, and a lessonId from another track, another course, or
// an unpublished session simply matches nothing.
//
// Phase B — that narrowing is now authorized with the SAME gate the lesson
// page itself uses (`canAccessLesson`: enrollment + course + PUBLISHED
// lifecycle + non-archived + track + progression unlock). A media path must
// never be a bypass: a lesson the student cannot open yields NO videos for
// it. The denial degrades to an EMPTY list — never a distinct status or code
// — so probing a locked / foreign / unpublished lesson id cannot even
// confirm the id is real (the same no-oracle rule the tree redaction uses).
// This is a GATE ON THE NARROWING, not a change of any batch/track/publication
// rule and not a change of progression semantics: the engine still decides
// unlock state exactly as before; this route only refuses to serve media for
// a lesson the engine would not let the student open.

import { NextRequest } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { getEnrollment, syncStudentBatch } from "@/lib/enrollment";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { videoTrackFilter } from "@/lib/track-scope";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import { canAccessLesson } from "@/lib/session-progress";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const lessonId = new URL(req.url).searchParams.get("lessonId") || null;

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

  // Phase B — lesson gate for the narrowing (see header): the student must be
  // able to open THIS session, or the session has no videos for them.
  if (lessonId) {
    const lessonAccess = await canAccessLesson(student.id, lessonId);
    if (!lessonAccess.allowed) {
      return ok({ isEnrolled: true, threshold: VIDEO_COMPLETION_THRESHOLD, videos: [] });
    }
  }

  const videos = await db.sessionVideo.findMany({
    // Phase 12 — the batch + published authorization above is unchanged; the
    // track check is layered ON TOP of it, never in place of it. A video's
    // track IS its batch's schoolType, so this re-derives the segment from the
    // row itself: even a stale or hand-edited `Student.batchId` can no longer
    // serve the other school type's recordings.
    where: {
      batchId,
      isPublished: true,
      // Phase 16 narrowing filter (see the header): no authorization is
      // derived from it — it only ever removes rows from an already-authorized
      // set, so a hostile or stale lessonId degrades to an empty list.
      ...(lessonId ? { lessonId } : {}),
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
      // Phase B — officialCode is the lesson's human-readable identity (1-1).
      // It is skeleton metadata (safe for every status, as the course tree
      // already serialises it) and lets the standalone library identify WHICH
      // session each recording belongs to without raw ids.
      lesson: { select: { id: true, title: true, titleAr: true, officialCode: true } },
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
