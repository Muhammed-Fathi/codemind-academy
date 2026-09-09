// CodeMind Academy — AI Quiz Generation API
// Uses z-ai-web-dev-sdk to generate quiz questions from lesson content.
import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import { requireRole, ok, err } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import { db } from "@/lib/db";
import type { Question } from "@prisma/client";
import { resolveQuestionSchoolType } from "@/lib/track-scope";

export async function POST(req: NextRequest) {
  const { user, error } = await requireRole("ADMIN", "TEACHER");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const { lessonId, count, difficulty } = body as {
    lessonId?: string;
    count?: number;
    difficulty?: string;
  };

  if (!lessonId) return err("Lesson ID مطلوب", 400);

  // BOTH curriculum chains — canonical (unit-linked) first, legacy topic as
  // fallback — the same resolution rule the progression engine uses.
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    include: {
      unit: {
        include: {
          part: { include: { course: true } },
        },
      },
      topic: {
        include: {
          unit: {
            include: {
              part: { include: { course: true } },
            },
          },
        },
      },
    },
  });
  if (!lesson) return err("الـLesson مش موجود", 404);

  // Archived lessons are retired history: generating fresh quizzes for them
  // would resurrect content the active curriculum no longer teaches. 410
  // Gone (not 404) so the caller knows the target is intentionally retired.
  if (lesson.curriculumStatus === "ARCHIVED") {
    const tApi = await getServerT();
    return err(tApi("api.227"), 410);
  }

  // TEACHER scope: a teacher may only generate questions for a lesson of one
  // of their own courses (the same ownership rule as POST /api/teacher/quizzes).
  // Admins remain unrestricted.
  const lessonCourseId =
    lesson.unit?.part.courseId ?? lesson.topic?.unit.part.courseId ?? null;
  if (user.role === "TEACHER") {
    if (!lessonCourseId) return err("الـLesson مش مرتبط بكورس", 404);
    const teacher = await db.teacher.findUnique({
      where: { userId: user.id },
      select: { groups: { select: { courseId: true } } },
    });
    const teacherCourseIds = teacher?.groups.map((g) => g.courseId) ?? [];
    if (!teacherCourseIds.includes(lessonCourseId)) {
      return err("مش مسموح تضيف أسئلة للـLesson ده", 403);
    }
  }

  const questionCount = Math.min(Math.max(count || 5, 1), 10);
  const diff = difficulty || "MIXED";

  // Build context from lesson (canonical chain first, legacy fallback)
  const chainUnit = lesson.unit ?? lesson.topic?.unit ?? null;
  const chainPart = lesson.unit?.part ?? lesson.topic?.unit.part ?? null;
  const chainCourse =
    lesson.unit?.part.course ?? lesson.topic?.unit.part.course ?? null;
  const context = [
    `Lesson Title: ${lesson.titleAr || lesson.title}`,
    `Topic: ${lesson.topic?.titleAr || lesson.topic?.title || "—"}`,
    `Unit: ${chainUnit?.titleAr || chainUnit?.title || "—"}`,
    `Part: ${chainPart?.titleAr || chainPart?.title || "—"}`,
    `Course: ${chainCourse?.nameAr || chainCourse?.name || "—"}`,
    lesson.description ? `Description: ${lesson.description}` : "",
    lesson.summary ? `Summary: ${lesson.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const diffInstruction =
    diff === "EASY"
      ? "سهلة (مستوى المبتدئ)"
      : diff === "MEDIUM"
      ? "متوسطة الصعوبة"
      : diff === "HARD"
      ? "صعبة (مستوى متقدم)"
      : "متنوعة الصعوبة";

  const systemPrompt = `إنت مساعد تعليمي متخصص في إنشاء أسئلة Quizzes لطلاب الثانوية العامة في مادة Programming & AI.

مهمتك: توليد ${questionCount} أسئلة اختيار من متعدد (MCQ) أو صح/خطأ (TRUE_FALSE) بناءً على محتوى Lesson معطى.

متطلبات الأسئلة:
1. الأسئلة لازم تكون مرتبطة مباشرة بمحتوى الـLesson
2. كل سؤال له 4 خيارات للـMCQ أو خيارين للـTRUE_FALSE
3. حدد الإجابة الصحيحة بشكل واضح
4. اكتب شرح مختصر لكل إجابة (explanation)
5. الصعوبة: ${diffInstruction}
6. الأسئلة بالعربية المصرية مع المصطلحات التقنية بالإنجليزي

مطلوب الرد بصيغة JSON فقط (بدون نص إضافي):
{
  "questions": [
    {
      "type": "MCQ",
      "prompt": "السؤال هنا",
      "options": ["الخيار 1", "الخيار 2", "الخيار 3", "الخيار 4"],
      "correctIndex": 0,
      "explanation": "شرح الإجابة",
      "difficulty": "EASY"
    }
  ]
}

محتوى الـLesson:
${context}`;

  try {
    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: systemPrompt },
        { role: "user", content: `ولّد ${questionCount} أسئلة للـLesson ده.` },
      ],
      thinking: { type: "disabled" },
    });

    const raw = completion?.choices?.[0]?.message?.content || "";
    // Extract JSON from response (might have markdown code blocks)
    let jsonStr = raw;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return err("الـAI ردّ بشكل مش صحيح. حاول تاني.", 500);
    }

    if (!parsed.questions || !Array.isArray(parsed.questions)) {
      return err("الـAI ماولّدش أسئلة صحيحة. حاول تاني.", 500);
    }

    // Save generated questions to the database
    const created: Question[] = [];
    for (const q of parsed.questions.slice(0, questionCount)) {
      if (!q.prompt || !q.options || q.correctIndex === undefined) continue;

      const questionType = q.type === "TRUE_FALSE" ? "TRUE_FALSE" : "MCQ";
      const options =
        questionType === "TRUE_FALSE"
          ? ["True", "False"]
          : q.options.slice(0, 4);

      // Ensure we have at least 2 options
      if (options.length < 2) continue;

      const correctIdx =
        typeof q.correctIndex === "number"
          ? Math.min(Math.max(q.correctIndex, 0), options.length - 1)
          : 0;

      // Find or create a quiz for this lesson
      let quiz = await db.quiz.findFirst({
        where: { lessonId },
        orderBy: { order: "desc" },
      });
      if (!quiz) {
        quiz = await db.quiz.create({
          data: {
            lessonId,
            title: `AI Quiz — ${lesson.titleAr || lesson.title}`,
            titleAr: `اختبار — ${lesson.titleAr || lesson.title}`,
            description: "أسئلة مولّدة بالـAI",
            passMark: 60,
            order: 1,
          },
        });
      }

      const question = await db.question.create({
        data: {
          quizId: quiz.id,
          type: questionType,
          prompt: q.prompt,
          promptAr: q.prompt,
          options: JSON.stringify(options),
          answer: String(correctIdx),
          explanation: q.explanation || "",
          difficulty: (q.difficulty || diff || "MEDIUM").toUpperCase(),
          marks: 1,
          // Phase 12 — generated questions inherit the owning quiz's track
          // scope explicitly rather than defaulting to SHARED, so an
          // ARABIC-only quiz never receives shared-tagged questions.
          schoolType: resolveQuestionSchoolType(undefined, quiz.trackScope),
        },
      });
      created.push(question);
    }

    return ok({
      generated: created.length,
      questions: created,
      quizId: created[0]?.quizId || null,
    });
  } catch (e: any) {
    console.error("[AI generate quiz error]", e);
    return err("حصلت مشكلة في الـAI. حاول تاني.", 500);
  }
}
