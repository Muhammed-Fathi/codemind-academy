import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Lesson Bookmarks API
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

// GET /api/students/me/bookmarks — list all bookmarks with lesson info
export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.120"), 404);

  const bookmarks = await db.lessonBookmark.findMany({
    where: { studentId: student.id },
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
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.120"), 404);

  const body = await req.json().catch(() => ({}));
  const { lessonId } = body as { lessonId?: string };
  if (!lessonId) return err(tApi("api.121"), 400);

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
