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
          // Phase M4.2 — the printed code is context, never identity: the same
          // code exists at both Academic Levels (`@@unique([academicLevel,
          // officialCode])`), so it is always rendered NEXT TO the level.
          officialCode: true,
          // Derived denormalized cache (`Lesson.academicLevel`). Used only as a
          // last-resort caption when the canonical chain below is gone; the
          // canonical `Course.academicLevel` always wins when it exists.
          academicLevel: true,
          // Canonical chain first: Lesson → Unit → Part → Course.
          unit: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              part: {
                select: {
                  id: true,
                  title: true,
                  titleAr: true,
                  course: {
                    select: { id: true, name: true, nameAr: true, academicLevel: true },
                  },
                },
              },
            },
          },
          // Legacy chain, kept as the documented fallback: Lesson → Topic →
          // Unit → Part → Course (the pre-Phase-19 shape).
          topic: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              unit: {
                select: {
                  id: true,
                  title: true,
                  titleAr: true,
                  part: {
                    select: {
                      id: true,
                      title: true,
                      titleAr: true,
                      course: {
                        select: { id: true, name: true, nameAr: true, academicLevel: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return ok({
    bookmarks: bookmarks.map((b) => {
      // CANONICAL FIRST, legacy fallback — resolved server-side so no client
      // has to guess which chain a lesson belongs to. The two chains can never
      // both be "right": the canonical unit chain is the current curriculum
      // shape, the topic chain is history.
      const canonical = b.lesson.unit?.part ?? null;
      const legacy = b.lesson.topic?.unit?.part ?? null;
      const part = canonical ?? legacy;
      const unit = canonical ? b.lesson.unit : b.lesson.topic?.unit ?? null;
      const course = part?.course ?? null;
      return {
        id: b.id,
        lessonId: b.lessonId,
        createdAt: b.createdAt,
        lesson: {
          id: b.lesson.id,
          title: b.lesson.title,
          titleAr: b.lesson.titleAr,
          officialCode: b.lesson.officialCode,
          academicLevel: b.lesson.academicLevel,
        },
        // Enough context to disambiguate two bookmarks that share a printed
        // code and a title: WHICH chain (canonical vs legacy), the unit/part,
        // and the course (whose `academicLevel` is the canonical authority).
        context: {
          chain: canonical ? "UNIT" : legacy ? "TOPIC" : null,
          unit: unit ? { id: unit.id, title: unit.title, titleAr: unit.titleAr } : null,
          part: part ? { id: part.id, title: part.title, titleAr: part.titleAr } : null,
          course: course
            ? {
                id: course.id,
                name: course.name,
                nameAr: course.nameAr,
                academicLevel: course.academicLevel,
              }
            : null,
        },
      };
    }),
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
