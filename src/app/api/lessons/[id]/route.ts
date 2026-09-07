import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";
import { canAccessLesson } from "@/lib/session-progress";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { getServerT } from "@/lib/i18n-server";

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

  // Determine whether to reveal quiz answers. Students only see answers after
  // they have finished at least one attempt on the quiz. Staff (admin/teacher/
  // parent) always see answers.
  let revealQuizAnswers = user.role !== "STUDENT";
  if (user.role === "STUDENT") {
    const s = await db.student.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (s) {
      const finishedCount = await db.quizAttempt.count({
        where: {
          quizId: { in: lesson.quizzes.map((q) => q.id) },
          studentId: s.id,
          finishedAt: { not: null },
        },
      });
      revealQuizAnswers = finishedCount > 0;
    }
  }

  // Student progress + backend gating
  let progress:
    | {
        progress: number;
        isCompleted: boolean;
        lastViewedAt: string | null;
        videoPercent: number;
        videoCompleted: boolean;
      }
    | null = null;
  let requirements: unknown = null;
  if (user.role === "STUDENT") {
    const s = await getStudentProfile(user.id);
    if (!s) return err("Student profile not found", 404);

    // AUTHORIZATION: enrollment + previous-session completion are enforced
    // here, so opening the URL directly cannot bypass the lock.
    const tApi = await getServerT();
    const access = await canAccessLesson(s.id, id);
    if (!access.allowed) {
      return NextResponse.json(
        {
          error:
            access.reason === "NOT_ENROLLED" ? tApi("api.208") : tApi("api.209"),
          code: access.reason,
          requirements: access.status,
        },
        { status: 403 }
      );
    }
    requirements = access.status;

    if (s) {
      const lp = await db.lessonProgress.findUnique({
        where: { studentId_lessonId: { studentId: s.id, lessonId: lesson.id } },
      });
      if (lp) {
        progress = {
          progress: lp.progress,
          isCompleted: lp.isCompleted,
          lastViewedAt: lp.lastViewedAt ? lp.lastViewedAt.toISOString() : null,
          videoPercent: lp.videoPercent,
          videoCompleted: lp.videoCompleted,
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
            answer: revealQuizAnswers ? q.answer : undefined,
            explanation: revealQuizAnswers ? q.explanation : undefined,
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
    requirements,
    videoThreshold: VIDEO_COMPLETION_THRESHOLD,
    prevLessonId,
    nextLessonId,
  });
}
