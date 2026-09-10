import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Lesson Bookmarks API
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { getStudentSchoolType } from "@/lib/enrollment";
import { lessonCourseChainOr } from "@/lib/session-progress";
import {
  canStudentSeeLesson,
  studentLessonVisibilityWhere,
} from "@/lib/curriculum-visibility";

// GET /api/students/me/bookmarks — list all bookmarks with lesson info.
//
// Phase 16: a bookmark is cached frontend state, and cached state must never
// surface an unpublished session. The list is therefore filtered to the
// student's VISIBLE curriculum — PUBLISHED + not archived + own track + own
// enrolled course — the same predicate the course tree uses. A bookmark whose
// lesson later leaves the visible curriculum simply stops listing (its row is
// kept, so it reappears if the lesson returns); nothing here deletes rows.
export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({
    where: { userId: user.id },
    select: {
      id: true,
      group: { select: { courseId: true, isActive: true } },
    },
  });
  if (!student) return err(tApi("api.120"), 404);

  const courseId =
    student.group && student.group.isActive ? student.group.courseId : null;
  if (!courseId) return ok({ bookmarks: [] });

  const bookmarks = await db.lessonBookmark.findMany({
    where: {
      studentId: student.id,
      lesson: {
        ...studentLessonVisibilityWhere(
          await getStudentSchoolType(student.id)
        ),
        OR: lessonCourseChainOr(courseId),
      },
    },
    include: {
      lesson: {
        select: {
          id: true,
          title: true,
          titleAr: true,
          topic: { select: { unit: { select: { part: { select: { titleAr: true, title: true } } } } } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return ok({
    bookmarks: bookmarks.map((b) => ({
      id: b.id,
      lessonId: b.lessonId,
      createdAt: b.createdAt,
      lesson: b.lesson,
    })),
  });
}

// POST /api/students/me/bookmarks — add bookmark
//
// Phase 16: bookmarking an invisible lesson (DRAFT / READY / ARCHIVED /
// wrong-track / wrong-course / unenrolled) is refused with a plain 404 —
// identical to a nonexistent id, so probing ids learns nothing. Visibility is
// judged by the shared predicate, not by progression: a PUBLISHED + LOCKED
// session may be bookmarked (its skeleton is public to the student anyway),
// but its content still requires the unlock.
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.120"), 404);

  const body = await req.json().catch(() => ({}));
  const { lessonId } = body as { lessonId?: string };
  if (!lessonId) return err(tApi("api.121"), 400);

  const visible = await canStudentSeeLesson(student.id, lessonId);
  if (!visible) return err("Lesson not found", 404);

  const bm = await db.lessonBookmark.upsert({
    where: { studentId_lessonId: { studentId: student.id, lessonId } },
    update: {},
    create: { studentId: student.id, lessonId },
  });
  return ok({ bookmark: bm });
}

// DELETE /api/students/me/bookmarks?lessonId=X — remove bookmark
export async function DELETE(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.120"), 404);

  const url = new URL(req.url);
  const lessonId = url.searchParams.get("lessonId");
  if (!lessonId) return err(tApi("api.121"), 400);

  await db.lessonBookmark.deleteMany({
    where: { studentId: student.id, lessonId },
  });
  return ok({ ok: true });
}
