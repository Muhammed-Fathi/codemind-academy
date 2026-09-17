// GET /api/admin/mock-exams/eligible — what the Question Bank can actually
// offer a mock exam of this configuration.
//
//   ?schoolType=ARABIC|LANGUAGE   required; the exam's bank
//   &courseId=…                   optional; a course-bound exam's scope
//   &difficulty=EASY|MEDIUM|HARD  optional; the exam's difficulty setting
//   &list=1                       include the eligible questions (FIXED picker)
//   &search=…                     optional prompt filter for that picker
//
// The numbers come from src/lib/mock-exam-pool.ts — the SAME rule the student
// attempt path serves from and the create/publish guards measure. That is the
// whole point: the Admin sees the pool a student will really get, including
// questions created by hand in the Question Bank (no lesson, no AI metadata).
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
  countMockExamEligiblePool,
  loadMockExamLessonIds,
  mockExamQuestionPoolWhere,
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

  const lessonIds = await loadMockExamLessonIds(courseId);
  const pool = await countMockExamEligiblePool({
    schoolType,
    courseId,
    difficulty,
    lessonIds,
  });

  // The picker list is for FIXED exams: only Question rows can be pinned, so
  // that is what is listed (never the answer key).
  const withList = url.searchParams.get("list") === "1";
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
    const rows = await db.question.findMany({
      where: {
        AND: [
          mockExamQuestionPoolWhere(schoolType, lessonIds),
          difficultyFilter,
          searchFilter,
        ],
      },
      include: {
        quiz: { select: { lesson: { select: { titleAr: true, title: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
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
      };
    });
  }

  return ok({ schoolType, courseId, difficulty, pool, questions });
}
