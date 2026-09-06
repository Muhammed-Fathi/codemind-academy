// PATCH  /api/admin/mock-exams/[id] — update / publish a mock exam
// DELETE /api/admin/mock-exams/[id] — delete a definition (attempts survive)

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { normalizeSchoolType, questionBankFilter } from "@/lib/school-type";
import { getServerT } from "@/lib/i18n-server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const exam = await db.mockExam.findUnique({ where: { id } });
  if (!exam) return err(tApi("api.211"), 404);

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};

  if (typeof body.title === "string") data.title = body.title.trim();
  if (typeof body.titleAr === "string") data.titleAr = body.titleAr.trim();
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.isPublished === "boolean") data.isPublished = body.isPublished;
  if (body.questionCount !== undefined)
    data.questionCount = Math.min(100, Math.max(1, Number(body.questionCount)));
  if (body.durationMin !== undefined)
    data.durationMin = Math.min(300, Math.max(5, Number(body.durationMin)));
  if (body.passMark !== undefined)
    data.passMark = Math.min(100, Math.max(0, Number(body.passMark)));

  // Changing the student type re-binds the exam to the OTHER question bank, so
  // any pinned questions from the previous bank must be dropped — otherwise an
  // Arabic exam could keep serving Language questions.
  const nextSchoolType = normalizeSchoolType(body.schoolType);
  if (nextSchoolType && nextSchoolType !== exam.schoolType) {
    data.schoolType = nextSchoolType;
    const stale = await db.mockExamQuestion.findMany({
      where: {
        mockExamId: id,
        question: { schoolType: { not: nextSchoolType } },
      },
      select: { id: true },
    });
    if (stale.length) {
      await db.mockExamQuestion.deleteMany({
        where: { id: { in: stale.map((s) => s.id) } },
      });
    }
  }

  // Do not allow publishing an exam its bank cannot satisfy.
  if (data.isPublished === true) {
    const type = (data.schoolType as any) || exam.schoolType;
    const count = (data.questionCount as number) ?? exam.questionCount;
    const available = await db.question.count({
      where: questionBankFilter(type),
    });
    if (available < count) return err(tApi("api.213"), 400);
  }

  const updated = await db.mockExam.update({ where: { id }, data });
  return ok({ exam: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const exam = await db.mockExam.findUnique({ where: { id } });
  if (!exam) return err(tApi("api.211"), 404);

  // ExamAttempt.mockExamId is ON DELETE SET NULL and each attempt stores a JSON
  // snapshot of its own questions/answers, so historical results and reports
  // remain intact after the definition is removed.
  await db.mockExam.delete({ where: { id } });
  return ok({ ok: true });
}
