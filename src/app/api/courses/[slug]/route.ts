import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";

// GET /api/courses/[slug]
// Returns course + parts + units + topics + lessons with the current
// student's progress.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const course = await db.course.findUnique({
    where: { slug },
    include: {
      parts: {
        orderBy: { order: "asc" },
        include: {
          units: {
            orderBy: { order: "asc" },
            include: {
              topics: {
                orderBy: { order: "asc" },
                include: {
                  lessons: {
                    orderBy: { order: "asc" },
                    include: {
                      quizzes: { orderBy: { order: "asc" }, select: { id: true, titleAr: true, title: true } },
                      homeworks: { select: { id: true, titleAr: true, title: true, deadline: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      groups: { select: { id: true, name: true, schedule: true } },
    },
  });
  if (!course) return err("Course not found", 404);

  // Resolve student for progress lookups
  let studentId: string | null = null;
  if (user.role === "STUDENT") {
    const s = await getStudentProfile(user.id);
    studentId = s?.id || null;
  }

  // Pull all LessonProgress for this student for the lessons in this course
  const progressMap: Record<string, { progress: number; isCompleted: boolean; lastViewedAt: string | null }> = {};
  if (studentId) {
    const lessonIds = course.parts.flatMap((p) =>
      p.units.flatMap((u) => u.topics.flatMap((t) => t.lessons.map((l) => l.id)))
    );
    const progresses = await db.lessonProgress.findMany({
      where: { studentId, lessonId: { in: lessonIds } },
    });
    for (const p of progresses) {
      progressMap[p.lessonId] = {
        progress: p.progress,
        isCompleted: p.isCompleted,
        lastViewedAt: p.lastViewedAt ? p.lastViewedAt.toISOString() : null,
      };
    }
  }

  // Build the lesson list (ordered, flat) — used to determine locked state.
  // A lesson is "current" if it's the first not-completed lesson.
  // A lesson is "locked" if either the Lesson.isLocked flag is true AND the
  // previous lesson (by order) is not yet completed.
  type FlatLesson = {
    id: string;
    title: string;
    titleAr: string;
    order: number;
    duration: number;
    isLocked: boolean;
    partId: string;
    partTitle: string;
    partTitleAr: string;
    unitId: string;
    unitTitle: string;
    unitTitleAr: string;
    topicId: string;
    topicTitle: string;
    topicTitleAr: string;
    quizId: string | null;
    homeworkId: string | null;
    progress: number;
    isCompleted: boolean;
    status: "completed" | "current" | "locked" | "available";
  };

  const flat: FlatLesson[] = [];
  for (const part of course.parts) {
    for (const unit of part.units) {
      for (const topic of unit.topics) {
        for (const lesson of topic.lessons) {
          const lp = progressMap[lesson.id];
          const progress = lp?.progress || 0;
          const isCompleted = !!lp?.isCompleted;
          flat.push({
            id: lesson.id,
            title: lesson.title,
            titleAr: lesson.titleAr,
            order: lesson.order,
            duration: lesson.duration,
            isLocked: lesson.isLocked,
            partId: part.id,
            partTitle: part.title,
            partTitleAr: part.titleAr,
            unitId: unit.id,
            unitTitle: unit.title,
            unitTitleAr: unit.titleAr,
            topicId: topic.id,
            topicTitle: topic.title,
            topicTitleAr: topic.titleAr,
            quizId: lesson.quizzes[0]?.id || null,
            homeworkId: lesson.homeworks[0]?.id || null,
            progress,
            isCompleted,
            status: "available",
          });
        }
      }
    }
  }

  // Determine locked / current / completed statuses.
  // Logic: a lesson is "locked" if it has isLocked flag set AND the previous
  // lesson in the flat list is NOT completed. The first non-completed lesson
  // is "current".
  let foundCurrent = false;
  for (let i = 0; i < flat.length; i++) {
    const l = flat[i];
    if (l.isCompleted) {
      l.status = "completed";
      continue;
    }
    if (!foundCurrent) {
      // first incomplete lesson
      l.status = "current";
      foundCurrent = true;
    } else {
      // locked unless previous is completed
      const prev = flat[i - 1];
      if (l.isLocked && prev && !prev.isCompleted) {
        l.status = "locked";
      } else {
        l.status = "available";
      }
    }
  }

  // Reshape the parts/units/topics/lessons with progress + status attached
  const statusById: Record<string, FlatLesson["status"]> = {};
  for (const l of flat) statusById[l.id] = l.status;

  const parts = course.parts.map((part) => ({
    id: part.id,
    title: part.title,
    titleAr: part.titleAr,
    description: part.description,
    order: part.order,
    units: part.units.map((unit) => ({
      id: unit.id,
      title: unit.title,
      titleAr: unit.titleAr,
      order: unit.order,
      icon: unit.icon,
      topics: unit.topics.map((topic) => ({
        id: topic.id,
        title: topic.title,
        titleAr: topic.titleAr,
        order: topic.order,
        lessons: topic.lessons.map((lesson) => {
          const lp = progressMap[lesson.id];
          return {
            id: lesson.id,
            title: lesson.title,
            titleAr: lesson.titleAr,
            order: lesson.order,
            duration: lesson.duration,
            isLocked: lesson.isLocked,
            videoUrl: lesson.videoUrl,
            pdfUrl: lesson.pdfUrl,
            summary: lesson.summary,
            description: lesson.description,
            progress: lp?.progress || 0,
            isCompleted: !!lp?.isCompleted,
            status: statusById[lesson.id],
            quiz: lesson.quizzes[0] || null,
            homework: lesson.homeworks[0] || null,
          };
        }),
      })),
    })),
  }));

  // Compute overall progress (re-using flat for accuracy)
  const totalLessons = flat.length;
  const completedLessons = flat.filter((l) => l.isCompleted).length;
  const percentage =
    totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

  return ok({
    course: {
      id: course.id,
      slug: course.slug,
      name: course.name,
      nameAr: course.nameAr,
      description: course.description,
      color: course.color,
      iconUrl: course.iconUrl,
    },
    parts,
    progress: {
      totalLessons,
      completedLessons,
      percentage,
    },
  });
}
