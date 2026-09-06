import { getServerT } from "@/lib/i18n-server";
// GET /api/admin/question-bank?difficulty=&type=&search=
// POST /api/admin/question-bank — create question
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { normalizeSchoolType } from "@/lib/school-type";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const difficulty = url.searchParams.get("difficulty")?.trim();
  const type = url.searchParams.get("type")?.trim();
  const search = url.searchParams.get("search")?.trim();
  // Bank selector: ARABIC | LANGUAGE | "shared" (untagged) | all (default).
  const bankParam = url.searchParams.get("schoolType")?.trim() || "";
  const schoolType = normalizeSchoolType(bankParam);
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(
    200,
    Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10))
  );

  const where: any = {};
  if (schoolType) {
    // A bank view shows its own questions PLUS the shared (untagged) ones,
    // exactly like the pool a mock exam of that type draws from.
    where.OR = [{ schoolType }, { schoolType: null }];
  } else if (bankParam.toLowerCase() === "shared") {
    where.schoolType = null;
  }
  if (difficulty === "EASY" || difficulty === "MEDIUM" || difficulty === "HARD") {
    where.difficulty = difficulty;
  }
  if (type === "MCQ" || type === "TRUE_FALSE") {
    where.type = type;
  }
  if (search) {
    // Combine with a possible bank OR-clause without overwriting it.
    const searchClause = [
      { prompt: { contains: search } },
      { promptAr: { contains: search } },
    ];
    if (where.OR) {
      where.AND = [{ OR: where.OR }, { OR: searchClause }];
      delete where.OR;
    } else {
      where.OR = searchClause;
    }
  }

  const [total, questions, arabicCount, languageCount, sharedCount] =
    await Promise.all([
      db.question.count({ where }),
      db.question.findMany({
        where,
        include: {
          quiz: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              lesson: { select: { id: true, titleAr: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.question.count({ where: { schoolType: "ARABIC" } }),
      db.question.count({ where: { schoolType: "LANGUAGE" } }),
      db.question.count({ where: { schoolType: null } }),
    ]);

  return ok({
    questions: questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      promptAr: q.promptAr,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      difficulty: q.difficulty,
      marks: q.marks,
      schoolType: q.schoolType,
      quiz: q.quiz,
    })),
    counts: {
      ARABIC: arabicCount,
      LANGUAGE: languageCount,
      SHARED: sharedCount,
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
    },
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const prompt = String(body.prompt || "").trim();
  const promptAr = body.promptAr ? String(body.promptAr) : null;
  const type = (body.type === "TRUE_FALSE" ? "TRUE_FALSE" : "MCQ") as
    | "MCQ"
    | "TRUE_FALSE";
  const difficulty = (["EASY", "MEDIUM", "HARD"].includes(body.difficulty)
    ? body.difficulty
    : "MEDIUM") as "EASY" | "MEDIUM" | "HARD";
  const explanation = body.explanation ? String(body.explanation) : null;
  const marks = Number(body.marks || 1);
  const quizId = body.quizId ? String(body.quizId) : null;
  // null => shared question, usable by both the Arabic and Language banks.
  const questionSchoolType = normalizeSchoolType(body.schoolType);

  let optionsRaw: any = body.options;
  let answer = String(body.answer ?? "0");

  if (type === "TRUE_FALSE") {
    optionsRaw = ["True", "False"];
    answer = answer === "1" || String(answer).toLowerCase() === "false" ? "1" : "0";
  } else {
    if (!Array.isArray(optionsRaw) || optionsRaw.length < 2)
      return err(tApi("api.045"), 400);
  }

  if (!prompt) return err(tApi("api.046"), 400);

  const question = await db.question.create({
    data: {
      quizId,
      type,
      prompt,
      promptAr,
      options: JSON.stringify(optionsRaw),
      answer,
      explanation,
      difficulty,
      marks,
      schoolType: questionSchoolType,
    },
  });

  return ok({ question });
}
