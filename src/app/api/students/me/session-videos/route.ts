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
//
// Phase B (fix) — the SAME lesson authority now applies to the STANDALONE
// library (no lessonId) as well. The complete student video access rule:
//
//   A SessionVideo with a canonical lessonId is discoverable, listable and
//   playable by a student ONLY when the student is authorized to access that
//   Lesson under the existing lesson-access policy (`canAccessLesson`).
//
// Without this, a published recording of a LOCKED (or archived / DRAFT /
// foreign-course) lesson would remain listable — and therefore playable —
// through the secondary library even though the Lesson itself refused to
// open: an academic-access bypass. After the query below, every lesson-
// linked row is re-checked against `canAccessLesson` and the video is
// dropped when the lesson is not accessible. Lesson-less legacy rows
// (lessonId = null) keep the historical batch-publication behaviour — they
// are batch recordings with no canonical lesson to gate on.
//
// The lesson-page path, the heartbeat endpoint and the media delivery route
// enforce the SAME verdict, so the four surfaces can never disagree.

import { NextRequest } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { getEnrollment, syncStudentBatch } from "@/lib/enrollment";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { videoTrackFilter } from "@/lib/track-scope";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import { canAccessLesson } from "@/lib/session-progress";
import { isManagedPrivateStorage } from "@/lib/media";

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

  const found = await db.sessionVideo.findMany({
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

  // Phase B (fix) — standalone lesson authority (see header). The query above
  // returns every published video of the student's batch/track — including
  // recordings of lessons the student may NOT open yet. Re-check every
  // lesson-linked row against the SAME verdict the lesson page uses and drop
  // what is gated; lesson-less legacy rows pass untouched (historical
  // batch-publication behaviour is preserved by design). When the lesson
  // becomes accessible the row reappears — no client-side state, no
  // progression change: `canAccessLesson` simply returns true once the
  // engine unlocks the lesson.
  const lessonIds = [...new Set(found.filter((v) => v.lessonId).map((v) => v.lessonId!))];
  const lessonVerdicts = new Map(
    (await Promise.all(
      lessonIds.map(async (lid) => [lid, await canAccessLesson(student.id, lid)] as const),
    )).map(([lid, verdict]) => [lid, verdict.allowed]),
  );
  const videos = found.filter((v) => v.lessonId === null || lessonVerdicts.get(v.lessonId) === true);

  return ok({
    isEnrolled: true,
    threshold: VIDEO_COMPLETION_THRESHOLD,
    videos: videos.map((v) => {
      const view = v.views[0];
      const percent = view?.percent ?? 0;
      // Trackability is the storage contract, not a guess: only managed
      // private bytes (LOCAL_PRIVATE / S3) accrue server-verified watch %
      // through the heartbeat. EXTERNAL_URL rows never accrue.
      const trackable = isManagedPrivateStorage(v.media.storage);
      return {
        id: v.id,
        title: v.title,
        titleAr: v.titleAr,
        description: v.description,
        lesson: v.lesson,
        isRequiredForProgression: v.isRequiredForProgression,
        trackable,
        requiredPercent: v.requiredPercent,
        publishedAt: v.publishedAt,
        // Uploaded media is served only through the authorized route.
        src:
          v.media.storage === "EXTERNAL_URL"
            ? v.media.externalUrl
            : `/api/media/${v.media.id}`,
        isExternal: v.media.storage === "EXTERNAL_URL",
        progress: {
          percent,
          // Sticky history (never rewritten): enrichment for OPTIONAL videos.
          isCompleted: view?.isCompleted ?? false,
          watchedSec: view?.watchedSec ?? 0,
          // LIVE satisfaction of THIS video's own threshold — the engine's
          // rule, not the sticky flag. The UI checks THIS for REQUIRED
          // videos, so a retroactive threshold change reflects without
          // rewriting history.
          satisfied: trackable && percent >= v.requiredPercent,
        },
      };
    }),
  });
}
