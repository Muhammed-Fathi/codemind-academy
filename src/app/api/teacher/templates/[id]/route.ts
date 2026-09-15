import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Teacher Template by ID (DELETE only for now)
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER" && user.role !== "ADMIN")
    return err(tApi("api.185"), 403);

  const { id } = await params;

  let teacherId: string | undefined;
  if (user.role === "TEACHER") {
    const teacher = await db.teacher.findUnique({ where: { userId: user.id } });
    teacherId = teacher?.id;
  }

  // Teachers can only delete their own templates
  const where: any = { id };
  if (user.role === "TEACHER") where.teacherId = teacherId;

  // Phase 26D FIX — report what actually happened.
  //
  // The scoping above was already correct (a teacher's delete is constrained to
  // `teacherId`, so another teacher's template is never touched), but the route
  // answered `200 { ok: true }` unconditionally. Teacher B therefore got a
  // SUCCESS response for a delete that deleted nothing, and an Admin got
  // `ok: true` for an id that does not exist. A write endpoint that reports
  // success for a no-op is how a UI ends up showing a deleted item that is still
  // there — and it makes the ownership refusal invisible to any caller or test.
  //
  // Now: nothing matched → 404, identical for "does not exist" and "not yours",
  // so the endpoint is not an existence oracle for another teacher's templates.
  const result = await db.lessonPlanTemplate.deleteMany({ where });
  if (!result || result.count === 0) return err(tApi("api.293"), 404);
  return ok({ ok: true, deleted: result.count });
}
