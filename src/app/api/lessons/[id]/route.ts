import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import {
  canAccessLesson,
  LESSON_CHAIN_SELECT,
  orderCourseLessons,
  resolveLessonCourseId,
} from "@/lib/session-progress";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { safeParseOptions } from "@/lib/session-quiz";

// GET /api/lessons/[id]
// Returns lesson + quizzes + homework + student progress.
//
// The lesson's place in the curriculum is resolved through BOTH chains —
// the canonical `Lesson.unitId` (Course → Part → Unit → Lesson) first, the
// legacy `Lesson.topicId` (… → Topic → Lesson) as fallback — the exact rule
// the Phase 4 progression engine uses. A canonical lesson (topicId = null)
// therefore returns its part/unit/course instead of nulls, and the topic
// section is null only for lessons that genuinely have no topic.
//
// `quiz` keeps pointing at the FIRST quiz (backwards compatibility) while
// `quizzes` lists ALL of them: the Phase 4 engine requires EVERY quiz of a
// session to be attempted before the session completes, so every quiz must
// be reachable in the UI — hiding the second quiz of a lesson behind the
// first one would deadlock the session.
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
      unit: { include: { part: { include: { course: true } } } },
      topic: {
        include: {
          unit: {
            include: { part: { include: { course: true } } },
          },
        },
      },
      quizzes: {
        orderBy: [{ order: "asc" }, { id: "asc" }],
        include: { questions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
      },
      homeworks: { orderBy: { deadline: "asc" } },
    },
  });
  if (!lesson) return err("Lesson not found", 404);

  // Canonical chain first; legacy topic chain as fallback.
  const chainPart = lesson.unit?.part ?? lesson.topic?.unit.part ?? null;
  const chainUnit = lesson.unit ?? lesson.topic?.unit ?? null;
  const chainCourse = lesson.unit?.part.course ?? lesson.topic?.unit.part.course ?? null;

  // Find prev / next lessons in the same course, in the SAME deterministic
  // order the progression engine and the course tree use
  // (Part → Unit → Topic → Lesson → id). `orderCourseLessons` is the single
  // definition of that order — this route never invents a second one.
  let prevLessonId: string | null = null;
  let nextLessonId: string | null = null;
  const courseId = resolveLessonCourseId({
    id: lesson.id,
    order: lesson.order,
    videoUrl: lesson.videoUrl,
    unitId: lesson.unitId,
    topicId: lesson.topicId,
    unit: lesson.unit
      ? {
          id: lesson.unit.id,
          order: lesson.unit.order,
          part: { id: lesson.unit.part.id, order: lesson.unit.part.order, courseId: lesson.unit.part.courseId },
        }
      : null,
    topic: lesson.topic
      ? {
          order: lesson.topic.order,
          unit: {
            id: lesson.topic.unit.id,
            order: lesson.topic.unit.order,
            part: {
              id: lesson.topic.unit.part.id,
              order: lesson.topic.unit.part.order,
              courseId: lesson.topic.unit.part.courseId,
            },
          },
        }
      : null,
  });
  if (courseId) {
    const found = await db.lesson.findMany({
      where: {
        isPublished: true,
        OR: [
          { unit: { part: { courseId } } },
          { topic: { unit: { part: { courseId } } } },
        ],
      },
      select: LESSON_CHAIN_SELECT,
    });
    const ordered = orderCourseLessons(found, courseId);
    const currentIdx = ordered.findIndex((l) => l.id === id);
    if (currentIdx > 0) prevLessonId = ordered[currentIdx - 1].id;
    if (currentIdx >= 0 && currentIdx < ordered.length - 1)
      nextLessonId = ordered[currentIdx + 1].id;
  }

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
    const access = await canAccessLesson(s.id, id);
    if (!access.allowed) {
      return denyProgression(access.reason, "Lesson not found");
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

  const toQuizPayload = (q: (typeof lesson.quizzes)[number]) => ({
    id: q.id,
    title: q.title,
    titleAr: q.titleAr,
    description: q.description,
    passMark: q.passMark,
    questions: q.questions.map((q2) => ({
      id: q2.id,
      type: q2.type,
      prompt: q2.prompt,
      promptAr: q2.promptAr,
      options: safeParseOptions(q2.options),
      answer: revealQuizAnswers ? q2.answer : undefined,
      explanation: revealQuizAnswers ? q2.explanation : undefined,
      difficulty: q2.difficulty,
      marks: q2.marks,
    })),
  });

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
    part: chainPart
      ? {
          id: chainPart.id,
          title: chainPart.title,
          titleAr: chainPart.titleAr,
        }
      : null,
    unit: chainUnit
      ? {
          id: chainUnit.id,
          title: chainUnit.title,
          titleAr: chainUnit.titleAr,
        }
      : null,
    topic: lesson.topic
      ? {
          id: lesson.topic.id,
          title: lesson.topic.title,
          titleAr: lesson.topic.titleAr,
        }
      : null,
    course: chainCourse
      ? {
          id: chainCourse.id,
          slug: chainCourse.slug,
          name: chainCourse.name,
          nameAr: chainCourse.nameAr,
        }
      : null,
    // Every quiz of the session — the engine requires all of them.
    quizzes: lesson.quizzes.map(toQuizPayload),
    // First quiz, kept for backwards compatibility with older consumers.
    quiz: lesson.quizzes[0] ? toQuizPayload(lesson.quizzes[0]) : null,
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
