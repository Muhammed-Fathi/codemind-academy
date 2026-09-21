import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

/**
 * GET /api/admin/session-videos/eligible-sessions?batchId=&lessonId=
 *
 * The ABSENT_STUDENTS session picker source: LiveSessions the admin may
 * attach as a recording's absence source. The filter MIRRORS
 * `validateAbsentSessionLink` (same predicates, read-only): the session must
 * exist, not be CANCELLED, belong to the video's course, and be
 * lesson-compatible (linked to THIS lesson, or a general unlinked session).
 * The server ALWAYS re-validates on write — this list never widens what the
 * write paths accept. An empty list means ABSENT_STUDENTS is unexpressible
 * for this (batch × lesson), and the UI disables the option with an
 * explanation instead of offering a dead control.
 */
export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const sp = req.nextUrl.searchParams;
  const batchId = (sp.get("batchId") || "").trim();
  const lessonId = (sp.get("lessonId") || "").trim();
  if (!batchId || !lessonId) return err("batchId and lessonId are required", 400);

  const batch = await db.batch.findUnique({
    where: { id: batchId },
    select: { id: true, courseId: true },
  });
  if (!batch) return err("Batch not found", 404);

  const batchCourseId = (batch.courseId as string | null) ?? null;
  const sessions = await db.liveSession.findMany({
    where: {
      status: { not: "CANCELLED" },
      // Lesson-compatible: for THIS lesson, or a general (unlinked) session
      // the admin explicitly attaches. When the batch carries no course
      // anchor, only the exact lesson link qualifies (same rule as the
      // write-path validator).
      ...(batchCourseId === null
        ? { lessonId }
        : { OR: [{ lessonId }, { lessonId: null }] }),
      ...(batchCourseId === null ? {} : { group: { courseId: batchCourseId } }),
    },
    select: {
      id: true,
      title: true,
      titleAr: true,
      startAt: true,
      status: true,
      attendanceFinalizedAt: true,
      group: { select: { name: true } },
    },
    orderBy: { startAt: "desc" },
    take: 100,
  });

  return ok({
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      titleAr: s.titleAr,
      startAt: s.startAt,
      status: s.status,
      groupName: (s.group as { name: string } | null)?.name ?? null,
      finalized: s.attendanceFinalizedAt != null,
    })),
  });
}
