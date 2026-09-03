// CodeMind Academy — Teacher Template by ID (DELETE only for now)
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER" && user.role !== "ADMIN")
    return err("Templates متاحة للمعلمين فقط", 403);

  const { id } = await params;

  let teacherId: string | undefined;
  if (user.role === "TEACHER") {
    const teacher = await db.teacher.findUnique({ where: { userId: user.id } });
    teacherId = teacher?.id;
  }

  // Teachers can only delete their own templates
  const where: any = { id };
  if (user.role === "TEACHER") where.teacherId = teacherId;

  await db.lessonPlanTemplate.deleteMany({ where });
  return ok({ ok: true });
}
