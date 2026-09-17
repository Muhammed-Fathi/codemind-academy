// Admin mock-exam definitions.
//   GET  /api/admin/mock-exams?schoolType=ARABIC|LANGUAGE
//   POST /api/admin/mock-exams  — create an exam bound to ONE question bank
//
// The `schoolType` on the exam is what guarantees bank isolation: at attempt
// time `/api/exams/mock` only ever samples questions whose schoolType matches
// the exam, or which are explicitly shared (schoolType = null).
//
// POOL SCOPE (src/lib/mock-exam-pool.ts) — the number this route guards
// against is the SAME pool the student attempt path can serve from:
//   * bank-only questions (no lesson link — the Admin Question Bank), plus
//   * questions attached to a student-visible lesson of the exam's course
//     (every course when the exam is not course-bound).
// Counting anything else is how an exam ends up published but unservable.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { normalizeSchoolType, questionBankFilter } from "@/lib/school-type";
import { getServerT } from "@/lib/i18n-server";
import {
  countMockExamEligiblePool,
  loadMockExamLessonIds,
  mockExamQuestionPoolWhere,
  mockExamQuestionScopeWhere,
} from "@/lib/mock-exam-pool";

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

  // Per-exam ELIGIBLE pool: the same scope the student path uses (bank-only +
  // lesson-linked to the exam's course), counted ONCE per distinct
  // (schoolType, course, difficulty) binding through the shared contract in
  // src/lib/mock-exam-pool.ts — never a second, drifting count.
  const combos = new Map<string, { schoolType: "ARABIC" | "LANGUAGE"; courseId: string | null; difficulty: string }>();
  for (const e of exams) {
    combos.set(`${e.schoolType}|${e.courseId ?? ""}|${e.difficulty}`, {
      schoolType: e.schoolType,
      courseId: e.courseId ?? null,
      difficulty: e.difficulty,
    });
  }
  const eligibleByCombo = new Map<string, number>();
  for (const [key, combo] of combos) {
    const count = await countMockExamEligiblePool({
      schoolType: combo.schoolType,
      courseId: combo.courseId,
      difficulty: combo.difficulty,
    });
    eligibleByCombo.set(key, count.servable);
  }

  return ok({
    exams: exams.map((e) => ({
      id: e.id,
      title: e.title,
      titleAr: e.titleAr,
      description: e.description,
      schoolType: e.schoolType,
      course: e.course,
      courseId: e.courseId,
      questionCount: e.questionCount,
      durationMin: e.durationMin,
      passMark: e.passMark,
      difficulty: e.difficulty,
      selectionMode: e.selectionMode,
      isPublished: e.isPublished,
      pinnedQuestions: e._count.questions,
      attempts: e._count.attempts,
      /**
       * Questions the student path can actually serve for this exam's binding.
       * RANDOM exams needing more than this will be served short (and flagged);
       * FIXED exams are unaffected (their pins are explicit).
       */
      eligiblePool:
        eligibleByCombo.get(`${e.schoolType}|${e.courseId ?? ""}|${e.difficulty}`) ?? 0,
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

  let questionCount = Math.min(100, Math.max(1, Number(body.questionCount || 10)));
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

  // ---------------------------------------------------------------------
  // FIXED with an explicit selection: the Admin picked the exact questions.
  // ---------------------------------------------------------------------
  // `questionIds` is the FIXED contract the Admin UI uses. Every id must be a
  // real Question Bank row of the exam's own bank; the count is DERIVED from
  // the selection, and a conflicting `questionCount` is refused rather than
  // silently ignored.
  const rawQuestionIds: string[] | null = Array.isArray(body.questionIds)
    ? (body.questionIds as unknown[])
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter((v): v is string => v.length > 0)
    : null;

  // The eligible pool for THIS exam's bank + course, from the one canonical
  // rule (src/lib/mock-exam-pool.ts) shared with the student attempt path,
  // the Admin UI and the publish guard.
  const lessonIds = await loadMockExamLessonIds(courseId);
  const pool = await countMockExamEligiblePool({
    schoolType,
    courseId,
    difficulty,
    lessonIds,
  });

  let fixedQuestionIds: string[] = [];
  if (rawQuestionIds) {
    if (selectionMode !== "FIXED") return err(tApi("api.306"), 400);
    if (rawQuestionIds.length === 0) return err(tApi("api.307"), 400);
    fixedQuestionIds = [...new Set(rawQuestionIds)];
    if (fixedQuestionIds.length !== rawQuestionIds.length)
      return err(tApi("api.307"), 400);
    if (
      body.questionCount !== undefined &&
      Number(body.questionCount) !== fixedQuestionIds.length
    ) {
      return err(tApi("api.308"), 400);
    }
    // The selection IS the exam length: a FIXED exam serves its pins, so a
    // count that disagrees with them would misreport the exam.
    questionCount = fixedQuestionIds.length;
    // Every selected id must be eligible for THIS exam: a real Question Bank
    // row of the matching bank, and either a free-bank (lesson-less) row or a
    // question of a student-visible lesson on this exam's course. Rejecting
    // the rest keeps a FIXED exam from being pinned to material its students
    // must never see (another school's bank, another course, a draft lesson).
    const eligible = await db.question.findMany({
      where: {
        AND: [
          { id: { in: fixedQuestionIds } },
          questionBankFilter(schoolType),
          mockExamQuestionScopeWhere(lessonIds),
        ],
      },
      select: { id: true },
    });
    if (eligible.length !== fixedQuestionIds.length)
      return err(tApi("api.309"), 400);
  }
  // Guard: never create an exam the matching bank cannot satisfy, measured
  // against the pool the student path can actually serve — bank-only manual
  // questions PLUS questions of a student-visible lesson on the exam's course,
  // in both question tables, with the exam's difficulty applied exactly like
  // the attempt path applies it. `servable` is the shared contract, so this
  // guard and the student route cannot drift apart again.
  //
  // A FIXED exam with an explicit selection is already length-checked above
  // (its pins ARE the exam); a FIXED exam WITHOUT one is filled from the
  // Question bank, so there the QUESTION count is what must suffice.
  const available =
    selectionMode === "FIXED" && !rawQuestionIds ? pool.question : pool.servable;
  if (available < questionCount) {
    return err(
      tApi("api.213", { p1: questionCount, p2: available, p3: pool.bankOnly }),
      400
    );
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
    const pinnedIds: string[] = [...fixedQuestionIds];
    if (pinnedIds.length === 0) {
      // No explicit selection supplied (API-only path): fall back to the
      // eligible pool, so the legacy shape of this endpoint keeps working.
      const candidates = await db.question.findMany({
        where: {
          AND: [
            mockExamQuestionPoolWhere(schoolType, lessonIds),
            ...(difficulty !== "MIXED" ? [{ difficulty }] : []),
          ],
        },
        select: { id: true },
        take: questionCount * 3,
      });
      const picked = candidates
        .map((q) => ({ q, r: Math.random() }))
        .sort((a, b) => a.r - b.r)
        .slice(0, questionCount);
      pinnedIds.push(...picked.map((p) => p.q.id));
    }
    if (pinnedIds.length) {
      await db.mockExamQuestion.createMany({
        data: pinnedIds.map((questionId, i) => ({
          mockExamId: exam.id,
          questionId,
          order: i,
        })),
      });
    }
  }

  return ok({ exam });
}
