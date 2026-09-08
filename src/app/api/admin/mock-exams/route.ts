// Admin mock-exam definitions.
//   GET  /api/admin/mock-exams?schoolType=ARABIC|LANGUAGE
//   POST /api/admin/mock-exams  — create an exam bound to ONE question bank
//
// The `schoolType` on the exam is what guarantees bank isolation: at attempt
// time `/api/exams/mock` only ever samples questions whose schoolType matches
// the exam, or which are explicitly shared (schoolType = null).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { normalizeSchoolType, questionBankFilter } from "@/lib/school-type";
import { getServerT } from "@/lib/i18n-server";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const schoolType = normalizeSchoolType(url.searchParams.get("schoolType"));

  const exams = await db.mockExam.findMany({
    where: schoolType ? { schoolType } : {},
    orderBy: { createdAt: "desc" },
    include: {
      course: { select: { id: true, name: true, nameAr: true } },
      _count: { select: { questions: true, attempts: true } },
    },
    take: 100,
  });

  // Report how many questions each bank can actually offer, so the admin sees
  // immediately whether an exam is satisfiable. Mock exams draw from BOTH
  // question tables (Question + ExamQuestion), so the pool — and the guards
  // below — must count both, or satisfiable exams get rejected.
  const [arabicQ, arabicEQ, languageQ, languageEQ] = await Promise.all([
    db.question.count({ where: questionBankFilter("ARABIC") }),
    db.examQuestion.count({ where: questionBankFilter("ARABIC") }),
    db.question.count({ where: questionBankFilter("LANGUAGE") }),
    db.examQuestion.count({ where: questionBankFilter("LANGUAGE") }),
  ]);
  const arabicPool = arabicQ + arabicEQ;
  const languagePool = languageQ + languageEQ;

  return ok({
    exams: exams.map((e) => ({
      id: e.id,
      title: e.title,
      titleAr: e.titleAr,
      description: e.description,
      schoolType: e.schoolType,
      course: e.course,
      questionCount: e.questionCount,
      durationMin: e.durationMin,
      passMark: e.passMark,
      difficulty: e.difficulty,
      selectionMode: e.selectionMode,
      isPublished: e.isPublished,
      pinnedQuestions: e._count.questions,
      attempts: e._count.attempts,
      createdAt: e.createdAt,
    })),
    pools: { ARABIC: arabicPool, LANGUAGE: languagePool },
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  const titleAr = String(body.titleAr || title).trim();
  const schoolType = normalizeSchoolType(body.schoolType);

  if (!title) return err(tApi("api.187"), 400);
  // Student type is mandatory — an exam must always know its question bank.
  if (!schoolType) return err(tApi("api.210"), 400);

  const questionCount = Math.min(100, Math.max(1, Number(body.questionCount || 10)));
  const durationMin = Math.min(300, Math.max(5, Number(body.durationMin || 30)));
  const passMark = Math.min(100, Math.max(0, Number(body.passMark || 60)));
  const difficulty = ["EASY", "MEDIUM", "HARD", "MIXED"].includes(body.difficulty)
    ? body.difficulty
    : "MIXED";
  const selectionMode = body.selectionMode === "FIXED" ? "FIXED" : "RANDOM";
  const courseId = body.courseId ? String(body.courseId) : null;
  // A course-bound exam gates students by that course, so the binding must
  // be real — a typo'd id would otherwise make an exam nobody can open.
  if (courseId && !(await db.course.findUnique({ where: { id: courseId } }))) {
    return err(tApi("api.211"), 400);
  }

  // Guard: never create an exam the matching bank cannot satisfy. Both
  // question tables feed mock exams, so both count toward availability.
  const difficultyFilter = difficulty !== "MIXED" ? { difficulty } : {};
  const [availableQ, availableEQ] = await Promise.all([
    db.question.count({
      where: { ...questionBankFilter(schoolType), ...difficultyFilter },
    }),
    db.examQuestion.count({
      where: { ...questionBankFilter(schoolType), ...difficultyFilter },
    }),
  ]);
  const available = availableQ + availableEQ;
  if (available < questionCount) {
    return err(tApi("api.213"), 400);
  }

  const exam = await db.mockExam.create({
    data: {
      title,
      titleAr,
      description: body.description ? String(body.description) : null,
      schoolType,
      courseId,
      questionCount,
      durationMin,
      passMark,
      difficulty,
      selectionMode,
      isPublished: body.isPublished === true,
    },
  });

  // FIXED mode: pin a concrete set drawn ONLY from the matching bank.
  if (selectionMode === "FIXED") {
    const pool = await db.question.findMany({
      where: {
        ...questionBankFilter(schoolType),
        ...(difficulty !== "MIXED" ? { difficulty } : {}),
      },
      select: { id: true },
      take: questionCount * 3,
    });
    const picked = pool
      .map((q) => ({ q, r: Math.random() }))
      .sort((a, b) => a.r - b.r)
      .slice(0, questionCount);
    if (picked.length) {
      await db.mockExamQuestion.createMany({
        data: picked.map((p, i) => ({
          mockExamId: exam.id,
          questionId: p.q.id,
          order: i,
        })),
      });
    }
  }

  return ok({ exam });
}
