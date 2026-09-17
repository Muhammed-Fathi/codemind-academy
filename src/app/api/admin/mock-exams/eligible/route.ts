// GET /api/admin/mock-exams/eligible — what the Question Bank can actually
// offer a mock exam of this configuration.
//
//   ?schoolType=ARABIC|LANGUAGE   required; the exam's bank
//   &courseId=…                   optional; a course-bound exam's scope
//   &difficulty=EASY|MEDIUM|HARD  optional; the exam's difficulty setting
//   &mockExamId=…                 optional; include THAT exam's attachments
//   &list=1                       include the eligible questions (FIXED picker)
//   &list=pool                    include the FREE bank rows this exam may
//                                 attach (RANDOM pool membership)
//   &search=…                     optional prompt filter for either list
//
// The numbers come from src/lib/mock-exam-pool.ts — the SAME rule the student
// attempt path serves from and the create/publish guards measure. That is the
// whole point: the Admin sees the pool a student will really get, and a manual
// question created in the Question Bank (no lesson, no AI metadata) is part of
// it for exactly the exams it was attached to.
//
// ADMIN only, and deliberately key-free: the picker needs ids, prompts and
// metadata, never the stored answer or explanation.

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { normalizeSchoolType } from "@/lib/school-type";
import { getServerT } from "@/lib/i18n-server";
import {
  bankOnlyQuestionWhere,
  countMockExamEligiblePool,
  loadMockExamLessonIds,
  mockExamFixedPinWhere,
} from "@/lib/mock-exam-pool";

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const schoolType = normalizeSchoolType(url.searchParams.get("schoolType"));
  if (!schoolType) return err(tApi("api.210"), 400);

  const courseId = url.searchParams.get("courseId")?.trim() || null;
  if (courseId && !(await db.course.findUnique({ where: { id: courseId } }))) {
    return err(tApi("api.211"), 400);
  }
  const rawDifficulty = url.searchParams.get("difficulty") ?? "";
  // Typed as the stored Difficulty values (plus MIXED = "no filter"), so the
  // Prisma filter below is a valid `Difficulty` input, not a bare string.
  const difficulty: "MIXED" | "EASY" | "MEDIUM" | "HARD" =
    rawDifficulty === "EASY" ||
    rawDifficulty === "MEDIUM" ||
    rawDifficulty === "HARD" ||
    rawDifficulty === "MIXED"
      ? rawDifficulty
      : "MIXED";

  // The exam whose attachments extend the pool. Validated to belong to the
  // same bank + course as the query, so a crafted id cannot make the counts
  // describe a different exam's scope.
  const mockExamId = url.searchParams.get("mockExamId")?.trim() || null;
  if (mockExamId) {
    const exam = await db.mockExam.findUnique({
      where: { id: mockExamId },
      select: { schoolType: true, courseId: true },
    });
    if (!exam || exam.schoolType !== schoolType || (exam.courseId ?? null) !== courseId) {
      return err(tApi("api.211"), 404);
    }
  }

  const lessonIds = await loadMockExamLessonIds(courseId);
  const pool = await countMockExamEligiblePool({
    schoolType,
    courseId,
    difficulty,
    lessonIds,
    mockExamId,
  });

  // Two pickers, one shape (never the answer key):
  //   list=1     FIXED — every question this exam may PIN (bank + course or
  //              free bank, pinned by hand).
  //   list=pool  RANDOM — the FREE bank rows (no lesson) this exam may attach
  //              by id; the only way a manual question enters a RANDOM pool.
  const listMode = url.searchParams.get("list") || "";
  const withList = listMode === "1" || listMode === "pool";
  let questions: {
    id: string;
    type: string;
    prompt: string;
    promptAr: string | null;
    difficulty: string;
    marks: number;
    schoolType: string | null;
    bankOnly: boolean;
    lessonTitle: string | null;
    /** list=pool: already attached to THIS exam. */
    attached: boolean;
  }[] = [];
  if (withList) {
    const search = url.searchParams.get("search")?.trim() || "";
    const difficultyFilter: Prisma.QuestionWhereInput =
      difficulty !== "MIXED" ? { difficulty } : {};
    const searchFilter: Prisma.QuestionWhereInput = search
      ? {
          OR: [
            { prompt: { contains: search } },
            { promptAr: { contains: search } },
          ],
        }
      : {};
    const scopeWhere =
      listMode === "pool"
        ? // Only a lesson-less row can be an attachment (a lesson-linked row
          // is already in the exam's pool through its lesson).
          { AND: [mockExamFixedPinWhere(schoolType, lessonIds), bankOnlyQuestionWhere()] }
        : mockExamFixedPinWhere(schoolType, lessonIds);
    const rows = await db.question.findMany({
      where: { AND: [scopeWhere, difficultyFilter, searchFilter] },
      include: {
        quiz: { select: { lesson: { select: { titleAr: true, title: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    const attachedIds = mockExamId
      ? new Set(
          (
            await db.mockExamQuestion.findMany({
              where: { mockExamId, questionId: { not: null } },
              select: { questionId: true },
            })
          ).map((r) => r.questionId as string)
        )
      : new Set<string>();
    questions = rows.map((q) => {
      const lesson = q.quiz?.lesson ?? null;
      return {
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        promptAr: q.promptAr,
        difficulty: q.difficulty,
        marks: q.marks,
        schoolType: q.schoolType,
        // Manual Question Bank rows carry no quiz at all (Quiz.lessonId is
        // non-nullable, so "quiz without a lesson" cannot exist).
        bankOnly: !q.quizId,
        lessonTitle: lesson ? lesson.titleAr || lesson.title : null,
        attached: attachedIds.has(q.id),
      };
    });
  }

  return ok({ schoolType, courseId, difficulty, mockExamId, pool, questions });
}
