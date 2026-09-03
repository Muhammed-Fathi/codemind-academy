// CodeMind Academy — Lesson Notes API
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

// GET /api/students/me/notes?lessonId=X — list notes (optionally filtered)
export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err("ملف الطالب غير موجود", 404);

  const url = new URL(req.url);
  const lessonId = url.searchParams.get("lessonId");
  const where: any = { studentId: student.id };
  if (lessonId) where.lessonId = lessonId;

  const notes = await db.lessonNote.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    include: {
      lesson: { select: { id: true, title: true, titleAr: true } },
    },
  });

  return ok({
    notes: notes.map((n) => ({
      id: n.id,
      lessonId: n.lessonId,
      content: n.content,
      color: n.color,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
      lesson: n.lesson,
    })),
  });
}

// POST — create note
export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err("ملف الطالب غير موجود", 404);

  const body = await req.json().catch(() => ({}));
  const { lessonId, content, color } = body as {
    lessonId?: string;
    content?: string;
    color?: string;
  };
  if (!lessonId || !content) return err("Lesson ID + content مطلوبة", 400);

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
export async function PATCH(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err("ملف الطالب غير موجود", 404);

  const body = await req.json().catch(() => ({}));
  const { noteId, content, color } = body as {
    noteId?: string;
    content?: string;
    color?: string;
  };
  if (!noteId) return err("Note ID مطلوب", 400);

  const data: any = {};
  if (content) data.content = content;
  if (color) data.color = color;

  const note = await db.lessonNote.update({
    where: { id: noteId },
    data,
  });
  return ok({ note });
}

// DELETE /api/students/me/notes?noteId=X — delete note
export async function DELETE(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err("ملف الطالب غير موجود", 404);

  const url = new URL(req.url);
  const noteId = url.searchParams.get("noteId");
  if (!noteId) return err("Note ID مطلوب", 400);

  await db.lessonNote.deleteMany({
    where: { id: noteId, studentId: student.id },
  });
  return ok({ ok: true });
}
