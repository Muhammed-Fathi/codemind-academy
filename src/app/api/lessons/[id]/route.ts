import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";

// GET /api/lessons/[id]
// Returns lesson + quiz + homework + student progress.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const lesson = await db.lesson.findUnique({
    where: { id },
    include: {
      topic: {
        include: {
          unit: {
            include: {
              part: { include: { course: true } },
            },
          },
        },
      },
      quizzes: {
        orderBy: { order: "asc" },
        include: { questions: { orderBy: { createdAt: "asc" } } },
      },
      homeworks: { orderBy: { deadline: "asc" } },
    },
  });
  if (!lesson) return err("Lesson not found", 404);

  // Find prev / next lessons in the same course (by order)
  const courseLessons = await db.lesson.findMany({
    where: {
      topic: { unit: { part: { courseId: lesson.topic.unit.part.courseId } } },
    },
    orderBy: [{ topic: { unit: { part: { order: "asc" } } } }, { order: "asc" }],
    select: { id: true },
  });
  const currentIdx = courseLessons.findIndex((l) => l.id === lesson.id);
  const prevLessonId = currentIdx > 0 ? courseLessons[currentIdx - 1].id : null;
  const nextLessonId =
    currentIdx >= 0 && currentIdx < courseLessons.length - 1
      ? courseLessons[currentIdx + 1].id
      : null;

  // Student progress
  let progress: { progress: number; isCompleted: boolean; lastViewedAt: string | null } | null = null;
  if (user.role === "STUDENT") {
    const s = await getStudentProfile(user.id);
    if (s) {
      const lp = await db.lessonProgress.findUnique({
        where: { studentId_lessonId: { studentId: s.id, lessonId: lesson.id } },
      });
      if (lp) {
        progress = {
          progress: lp.progress,
          isCompleted: lp.isCompleted,
          lastViewedAt: lp.lastViewedAt ? lp.lastViewedAt.toISOString() : null,
        };
      }
      // Update lastViewedAt (touch) so dashboard "continue" works.
      await db.lessonProgress.upsert({
        where: { studentId_lessonId: { studentId: s.id, lessonId: lesson.id } },
        update: { lastViewedAt: new Date() },
        create: {
          studentId: s.id,
          lessonId: lesson.id,
          progress: 0,
          isCompleted: false,
          lastViewedAt: new Date(),
        },
      });
    }
  }

  return ok({
    lesson: {
      id: lesson.id,
      title: lesson.title,
      titleAr: lesson.titleAr,
      description: lesson.description,
      summary: lesson.summary,
      duration: lesson.duration,
      order: lesson.order,
      videoUrl: lesson.videoUrl,
      pdfUrl: lesson.pdfUrl,
      isLocked: lesson.isLocked,
    },
    part: {
      id: lesson.topic.unit.part.id,
      title: lesson.topic.unit.part.title,
      titleAr: lesson.topic.unit.part.titleAr,
    },
    unit: {
      id: lesson.topic.unit.id,
      title: lesson.topic.unit.title,
      titleAr: lesson.topic.unit.titleAr,
    },
    topic: {
      id: lesson.topic.id,
      title: lesson.topic.title,
      titleAr: lesson.topic.titleAr,
    },
    course: {
      id: lesson.topic.unit.part.course.id,
      slug: lesson.topic.unit.part.course.slug,
      name: lesson.topic.unit.part.course.name,
      nameAr: lesson.topic.unit.part.course.nameAr,
    },
    quiz: lesson.quizzes[0]
      ? {
          id: lesson.quizzes[0].id,
          title: lesson.quizzes[0].title,
          titleAr: lesson.quizzes[0].titleAr,
          description: lesson.quizzes[0].description,
          passMark: lesson.quizzes[0].passMark,
          questions: lesson.quizzes[0].questions.map((q) => ({
            id: q.id,
            type: q.type,
            prompt: q.prompt,
            promptAr: q.promptAr,
            options: JSON.parse(q.options),
            answer: q.answer,
            explanation: q.explanation,
            difficulty: q.difficulty,
            marks: q.marks,
          })),
        }
      : null,
    homework: lesson.homeworks[0]
      ? {
          id: lesson.homeworks[0].id,
          title: lesson.homeworks[0].title,
          titleAr: lesson.homeworks[0].titleAr,
          instructions: lesson.homeworks[0].instructions,
          deadline: lesson.homeworks[0].deadline,
          maxMarks: lesson.homeworks[0].maxMarks,
        }
      : null,
    progress,
    prevLessonId,
    nextLessonId,
  });
}
