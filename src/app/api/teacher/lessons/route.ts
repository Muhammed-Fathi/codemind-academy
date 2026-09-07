// GET /api/teacher/lessons — returns lessons available to the teacher
// (lessons in the teacher's course) for the quiz editor's lesson selector.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";

export async function GET(_req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const courseIds = teacher.groups.map((g) => g.courseId);
  if (courseIds.length === 0) return ok({ lessons: [] });

  const lessons = await db.lesson.findMany({
    where: { topic: { unit: { part: { courseId: { in: courseIds } } } } },
    orderBy: [{ topic: { unit: { part: { order: "asc" } } } }, { order: "asc" }],
    select: {
      id: true,
      title: true,
      titleAr: true,
      order: true,
      topic: {
        select: {
          id: true,
          title: true,
          titleAr: true,
          unit: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              part: {
                select: {
                  id: true,
                  title: true,
                  titleAr: true,
                  course: { select: { id: true, name: true, nameAr: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  // Group lessons by course → part → unit → topic for the UI
  const byCourse = new Map<
    string,
    {
      id: string;
      name: string;
      parts: Map<
        string,
        {
          id: string;
          title: string;
          titleAr: string;
          units: Map<
            string,
            {
              id: string;
              title: string;
              titleAr: string;
              topics: Map<
                string,
                {
                  id: string;
                  title: string;
                  titleAr: string;
                  lessons: Array<{
                    id: string;
                    title: string;
                    titleAr: string;
                  }>;
                }
              >;
            }
          >;
        }
      >;
    }
  >();

  for (const l of lessons) {
    const topic = l.topic;
    if (!topic) continue;
    const course = topic.unit.part.course;
    if (!course) continue;
    if (!byCourse.has(course.id)) {
      byCourse.set(course.id, {
        id: course.id,
        name: course.nameAr || course.name,
        parts: new Map(),
      });
    }
    const c = byCourse.get(course.id)!;
    const partId = topic.unit.part.id;
    if (!c.parts.has(partId)) {
      c.parts.set(partId, {
        id: partId,
        title: topic.unit.part.titleAr || topic.unit.part.title,
        titleAr: topic.unit.part.titleAr,
        units: new Map(),
      });
    }
    const p = c.parts.get(partId)!;
    const unitId = topic.unit.id;
    if (!p.units.has(unitId)) {
      p.units.set(unitId, {
        id: unitId,
        title: topic.unit.titleAr || topic.unit.title,
        titleAr: topic.unit.titleAr,
        topics: new Map(),
      });
    }
    const u = p.units.get(unitId)!;
    const topicId = topic.id;
    if (!u.topics.has(topicId)) {
      u.topics.set(topicId, {
        id: topicId,
        title: topic.titleAr || topic.title,
        titleAr: topic.titleAr,
        lessons: [],
      });
    }
    const t = u.topics.get(topicId)!;
    t.lessons.push({
      id: l.id,
      title: l.titleAr || l.title,
      titleAr: l.titleAr,
    });
  }

  const grouped = Array.from(byCourse.values()).map((c) => ({
    id: c.id,
    name: c.name,
    parts: Array.from(c.parts.values()).map((p) => ({
      id: p.id,
      title: p.title,
      titleAr: p.titleAr,
      units: Array.from(p.units.values()).map((u) => ({
        id: u.id,
        title: u.title,
        titleAr: u.titleAr,
        topics: Array.from(u.topics.values()).map((t) => ({
          id: t.id,
          title: t.title,
          titleAr: t.titleAr,
          lessons: t.lessons,
        })),
      })),
    })),
  }));

  return ok({ lessons, grouped });
}
