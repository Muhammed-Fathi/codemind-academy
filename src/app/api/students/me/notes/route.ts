import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Lesson Notes API
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import {
  LESSON_VISIBILITY_SELECT,
  canStudentSeeLesson,
  isLessonVisibleToViewer,
} from "@/lib/curriculum-visibility";

// GET /api/students/me/notes?lessonId=X — list notes (optionally filtered)
//
// Phase 16: the note CONTENT is the student's own words and stays readable,
// but the attached lesson TITLE is curriculum data, so it is redacted (`null`)
// whenever the lesson is outside the student's visible curriculum (DRAFT /
// READY / ARCHIVED / wrong track / wrong course / unenrolled). A note taken
// on a session that is later unpublished therefore keeps the student's words
// while revealing nothing about the session itself.
export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({
    where: { userId: user.id },
    select: {
      id: true,
      schoolType: true,
      group: { select: { courseId: true, isActive: true } },
    },
  });
  if (!student) return err(tApi("api.137"), 404);

  const url = new URL(req.url);
  const lessonId = url.searchParams.get("lessonId");
  const where: any = { studentId: student.id };
  if (lessonId) where.lessonId = lessonId;

  const notes = await db.lessonNote.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    include: {
      lesson: {
        select: {
          ...LESSON_VISIBILITY_SELECT,
          title: true,
          titleAr: true,
        },
      },
    },
  });

  const viewer = {
    schoolType: student.schoolType,
    courseId:
      student.group && student.group.isActive ? student.group.courseId : null,
  };

  return ok({
    notes: notes.map((n) => ({
      id: n.id,
      lessonId: n.lessonId,
      content: n.content,
      color: n.color,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      lesson:
        n.lesson && isLessonVisibleToViewer(n.lesson, viewer)
          ? { id: n.lesson.id, title: n.lesson.title, titleAr: n.lesson.titleAr }
          : null,
    })),
  });
}

// POST — create note
//
// Phase 16: notes may only be attached to visible lessons. Creating a note on
// a DRAFT/READY session would otherwise let the notes list (or a future
// surface that joins it) confirm the session exists. The refusal is a plain
// 404, identical to a nonexistent id.
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.137"), 404);

  const body = await req.json().catch(() => ({}));
  const { lessonId, content, color } = body as {
    lessonId?: string;
    content?: string;
    color?: string;
  };
  if (!lessonId || !content) return err(tApi("api.138"), 400);

  const visible = await canStudentSeeLesson(student.id, lessonId);
  if (!visible) return err("Lesson not found", 404);

  const note = await db.lessonNote.create({
    data: {
      studentId: student.id,
      lessonId,
      content,
      color: color || "amber",
    },
  });
  return ok({ note });
}

// PATCH — update note
//
// Phase 16 IDOR fix: the update is scoped to (noteId, studentId). The previous
// shape updated by note id alone, so any authenticated student could rewrite
// any other student's note by guessing its id. A note that is not the
// caller's own answers exactly like a nonexistent one.
export async function PATCH(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.137"), 404);

  const body = await req.json().catch(() => ({}));
  const { noteId, content, color } = body as {
    noteId?: string;
    content?: string;
    color?: string;
  };
  if (!noteId) return err(tApi("api.139"), 400);

  const data: any = {};
  if (content) data.content = content;
  if (color) data.color = color;

  const owned = await db.lessonNote.findFirst({
    where: { id: noteId, studentId: student.id },
    select: { id: true },
  });
  if (!owned) return err("Not found", 404);

  const note = await db.lessonNote.update({
    where: { id: noteId },
    data,
  });
  return ok({ note });
}

// DELETE /api/students/me/notes?noteId=X — delete note
export async function DELETE(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.137"), 404);

  const url = new URL(req.url);
  const noteId = url.searchParams.get("noteId");
  if (!noteId) return err(tApi("api.139"), 400);

  await db.lessonNote.deleteMany({
    where: { id: noteId, studentId: student.id },
  });
  return ok({ ok: true });
}
