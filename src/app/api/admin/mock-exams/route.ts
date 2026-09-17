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
//   * questions attached to a student-visible lesson of the exam's course
//     (every course when the exam is not course-bound), plus
//   * free Question Bank rows (no lesson link — what the Admin's "Add
//     Question" dialog produces) that THIS exam attached by id.
// A manual question is therefore never eligible for every course of the bank:
// it reaches exactly the exams it was attached to (`questionIds` on a RANDOM
// exam = pool membership; on a FIXED exam the same rows are the pins).
// Counting anything else is how an exam ends up published but unservable.

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { normalizeSchoolType, questionBankFilter } from "@/lib/school-type";
import { getServerT } from "@/lib/i18n-server";
import {
  countMockExamEligiblePool,
  loadMockExamLessonIds,
  mockExamFixedPinWhere,
  mockExamRandomPoolWhere,
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

  // Per-exam ELIGIBLE pool: the same scope the student path uses (lesson-linked
  // to the exam's course + the free bank rows THIS exam attached), counted
  // through the shared contract in src/lib/mock-exam-pool.ts — never a second,
  // drifting count. The base count (no attachments) is memoized per distinct
  // (schoolType, course, difficulty) binding; an exam that attached questions
  // gets its own exact count, because its pool is its own.
  const comboKey = (e: { schoolType: string; courseId: string | null; difficulty: string }) =>
    `${e.schoolType}|${e.courseId ?? ""}|${e.difficulty}`;
  const combos = new Map<string, { schoolType: "ARABIC" | "LANGUAGE"; courseId: string | null; difficulty: string }>();
  for (const e of exams) {
    combos.set(comboKey(e), {
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
  const eligibleByExam = new Map<string, number>();
  for (const e of exams) {
    if (e._count.questions === 0) continue;
    const count = await countMockExamEligiblePool({
      schoolType: e.schoolType,
      courseId: e.courseId ?? null,
      difficulty: e.difficulty,
      mockExamId: e.id,
    });
    eligibleByExam.set(e.id, count.servable);
  }
  // How many attempts each exam has actually TAKEN: an attempt row is opened
  // when a student starts a paper, so the raw relation count would include
  // papers that are still open. Only FINISHED rows are attempts.
  const finishedAttempts = new Map<string, number>();
  {
    const rows = await db.examAttempt.findMany({
      where: { mockExamId: { in: exams.map((e) => e.id) }, finishedAt: { not: null } },
      select: { mockExamId: true },
    });
    for (const r of rows) {
      if (!r.mockExamId) continue;
      finishedAttempts.set(r.mockExamId, (finishedAttempts.get(r.mockExamId) ?? 0) + 1);
    }
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
      /** FIXED: the pins. RANDOM: the free bank rows attached to this exam. */
      pinnedQuestions: e._count.questions,
      attempts: finishedAttempts.get(e.id) ?? 0,
      /**
       * Questions the student path can actually serve for this exam's binding.
       * RANDOM exams needing more than this will be served short (and flagged);
       * FIXED exams are unaffected (their pins are explicit).
       */
      eligiblePool:
        eligibleByExam.get(e.id) ?? eligibleByCombo.get(comboKey(e)) ?? 0,
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
  // An explicit selection means two different things per mode:
  //   FIXED  — the Admin picked the exact questions; they ARE the paper.
  //   RANDOM — the Admin attached free Question Bank rows to THIS exam; they
  //            join the exam's pool and may be sampled into the paper.
  // In both modes every id must be a real Question Bank row of the exam's own
  // bank that is either lesson-linked inside the exam's course or a free bank
  // question chosen by hand.
  // ---------------------------------------------------------------------
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
  let attachedQuestionIds: string[] = [];
  if (rawQuestionIds) {
    if (rawQuestionIds.length === 0) return err(tApi("api.307"), 400);
    const unique = [...new Set(rawQuestionIds)];
    if (unique.length !== rawQuestionIds.length) return err(tApi("api.307"), 400);
    if (selectionMode === "FIXED") {
      if (
        body.questionCount !== undefined &&
        Number(body.questionCount) !== unique.length
      ) {
        return err(tApi("api.308"), 400);
      }
      // The selection IS the exam length: a FIXED exam serves its pins, so a
      // count that disagrees with them would misreport the exam.
      questionCount = unique.length;
      fixedQuestionIds = unique;
    } else {
      // RANDOM: the ids extend the pool; the exam length stays the Admin's
      // configured count (and must be satisfiable — checked below).
      attachedQuestionIds = unique;
    }
    // Every selected id must be eligible for THIS exam: a real Question Bank
    // row of the matching bank, and either a free-bank (lesson-less) row or a
    // question of a student-visible lesson on this exam's course. Rejecting
    // the rest keeps an exam from being bound to material its students must
    // never see (another school's bank, another course, a draft lesson).
    const eligible = await db.question.findMany({
      where: {
        AND: [
          { id: { in: unique } },
          mockExamFixedPinWhere(schoolType, lessonIds),
        ],
      },
      select: { id: true },
    });
    if (eligible.length !== unique.length) return err(tApi("api.309"), 400);
  }
  // Guard: never create an exam the matching bank cannot satisfy, measured
  // against the pool the student path can actually serve — the questions of a
  // student-visible lesson on the exam's course PLUS the free bank rows the
  // exam attached, in both question tables, with the exam's difficulty applied
  // exactly like the attempt path applies it. `servable` is the shared
  // contract, so this guard and the student route cannot drift apart again.
  //
  // An explicit selection changes what there is to count:
  //   * FIXED — the validated pins ARE the paper (api.309 proved every id
  //     eligible), so the count is satisfied by construction;
  //   * RANDOM — the rows are attachments that only exist after the exam row
  //     is created, so the real measurement happens below, on the pool that
  //     includes them.
  // A FIXED exam WITHOUT a selection is still filled from the Question bank,
  // so there the QUESTION count is what must suffice.
  const selectionSatisfiesItself = !!rawQuestionIds;
  if (!selectionSatisfiesItself) {
    const available =
      selectionMode === "FIXED" ? pool.question : pool.servable;
    if (available < questionCount) {
      return err(
        tApi("api.213", { p1: questionCount, p2: available, p3: pool.bankOnly }),
        400
      );
    }
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
      // Published only after the exam's real pool (attachments included) has
      // been measured below: a row that cannot serve a full paper must never be
      // visible to students.
      isPublished: false,
    },
  });

  // RANDOM mode: the explicit selection is POOL MEMBERSHIP. The rows are the
  // exam's own attachments (`MockExamQuestion`), which is what scopes a free
  // manual question to THIS exam — and to no other course.
  if (selectionMode === "RANDOM" && attachedQuestionIds.length) {
    await db.mockExamQuestion.createMany({
      data: attachedQuestionIds.map((questionId, i) => ({
        mockExamId: exam.id,
        questionId,
        order: i,
      })),
    });
  }

  // FIXED mode: pin a concrete set drawn ONLY from the matching bank.
  if (selectionMode === "FIXED") {
    const pinnedIds: string[] = [...fixedQuestionIds];
    if (pinnedIds.length === 0) {
      // No explicit selection supplied (API-only path): fall back to the
      // eligible pool, so the legacy shape of this endpoint keeps working.
      const difficultyFilter: Prisma.QuestionWhereInput =
        difficulty !== "MIXED" ? { difficulty } : {};
      const candidates = await db.question.findMany({
        where: {
          AND: [
            mockExamRandomPoolWhere(schoolType, lessonIds, null),
            difficultyFilter,
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

  // The REAL guard for a RANDOM exam: the pool now includes the rows this exam
  // just attached, so the number measured is exactly what a student attempt
  // can be served. Insufficient => the draft row is removed again (its links
  // cascade) and nothing is left behind.
  if (selectionMode === "RANDOM") {
    const full = await countMockExamEligiblePool({
      schoolType,
      courseId,
      difficulty,
      lessonIds,
      mockExamId: exam.id,
    });
    if (full.servable < questionCount) {
      await db.mockExam.delete({ where: { id: exam.id } });
      return err(
        tApi("api.213", { p1: questionCount, p2: full.servable, p3: full.bankOnly }),
        400
      );
    }
  }

  const published =
    body.isPublished === true
      ? await db.mockExam.update({
          where: { id: exam.id },
          data: { isPublished: true },
        })
      : exam;

  return ok({ exam: published });
}
