// PATCH  /api/admin/mock-exams/[id] — update / publish a mock exam
// DELETE /api/admin/mock-exams/[id] — delete a definition (attempts survive)

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { normalizeSchoolType, questionBankFilter } from "@/lib/school-type";
import { getServerT } from "@/lib/i18n-server";
import { countMockExamEligiblePool } from "@/lib/mock-exam-pool";

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
  // Arabic exam could keep serving Language questions. Pins can point at
  // EITHER question table, so both link types are swept (shared/null pins
  // survive: `not` never matches NULL, which is exactly the shared semantic).
  const nextSchoolType = normalizeSchoolType(body.schoolType);
  if (nextSchoolType && nextSchoolType !== exam.schoolType) {
    data.schoolType = nextSchoolType;
    const stale = await db.mockExamQuestion.findMany({
      where: {
        mockExamId: id,
        OR: [
          { question: { schoolType: { not: nextSchoolType } } },
          { examQuestion: { schoolType: { not: nextSchoolType } } },
        ],
      },
      select: { id: true },
    });
    if (stale.length) {
      await db.mockExamQuestion.deleteMany({
        where: { id: { in: stale.map((s) => s.id) } },
      });
    }
  }

  // Do not allow publishing an exam its bank cannot satisfy. Both question
  // tables feed mock exams, so both count toward availability — and the count
  // uses the SAME scope the student attempt path serves from (bank-only
  // manual questions plus a student-visible lesson on the exam's course),
  // otherwise a publishable exam can still be unservable.
  if (data.isPublished === true) {
    const type = (data.schoolType as any) || exam.schoolType;
    const count = (data.questionCount as number) ?? exam.questionCount;
    const course = (data.courseId as string | null | undefined) ?? exam.courseId ?? null;
    if (exam.selectionMode === "FIXED") {
      // A FIXED exam is served from its pins, so the pins are what must cover
      // the configured count — not the pool.
      const pins = await db.mockExamQuestion.count({ where: { mockExamId: id } });
      if (pins < count) return err(tApi("api.312", { p1: count, p2: pins }), 400);
    } else {
      // RANDOM: the scope, the difficulty and the pool all come from the same
      // shared contract the student path and the create guard use.
      const pool = await countMockExamEligiblePool({
        schoolType: type,
        courseId: course,
        difficulty: exam.difficulty,
      });
      if (pool.servable < count)
        return err(
          tApi("api.213", { p1: count, p2: pool.servable, p3: pool.bankOnly }),
          400
        );
    }
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

  // Historical results MUST survive deletion of the definition. Each attempt
  // stores a JSON snapshot of its own questions/answers, so the score stays
  // readable; here we only have to clear the dangling link.
  //
  // We detach EXPLICITLY rather than relying on `onDelete: SetNull`. That
  // referential action is declared in schema.prisma, but the 2026 migration
  // adds `ExamAttempt.mockExamId` with a plain `ALTER TABLE ... ADD COLUMN`
  // and SQLite cannot attach a foreign key to an existing table without a full
  // table rebuild — which would break the additive-only guarantee of that
  // migration. So on an upgraded database no FK exists to fire, and a bare
  // delete would leave attempts pointing at a missing exam. Doing it in a
  // transaction keeps the two statements atomic and makes the behaviour
  // identical on both freshly-created and migrated databases.
  await db.$transaction([
    db.examAttempt.updateMany({
      where: { mockExamId: id },
      data: { mockExamId: null },
    }),
    db.mockExam.delete({ where: { id } }),
  ]);
  return ok({ ok: true });
}
