// GET /api/teacher/lessons — the lesson picker for every teacher authoring
// surface (quiz editor, homework editor, question management).
//
// WHAT IT RETURNS, AND WHY
//   The picker is the teacher's map of their own courses, so it carries the
//   fields a teacher needs to recognise a session unambiguously:
//
//     officialCode · Part · Unit · title · trackScope · lifecycle · chain
//
//   `officialCode` and the canonical Part/Unit are what identify a session of
//   the OFFICIAL curriculum (Phase 11); without them two sessions with the
//   same title are indistinguishable in a dropdown, which is how a quiz ends
//   up attached to the wrong lesson.
//
// CANONICAL, NOT TOPIC-ONLY
//   Lessons belong to a course through `Lesson.unitId → Unit → Part → Course`
//   (canonical, used by every official lesson) OR the legacy
//   `Lesson.topicId → Topic → Unit → Part → Course`. Both chains are queried
//   and both are returned; the canonical one WINS when a lesson carries both,
//   which is the same precedence the progression engine uses
//   (`resolveLessonCourseId`). The legacy Topic node survives in the payload
//   only so pre-Phase-11 content stays placeable in the tree — no Topic
//   semantics are re-introduced into the canonical path.
//
// MANAGEMENT, NOT STUDENT VISIBILITY
//   Archived lessons and DRAFT/READY lessons are INCLUDED: a teacher manages
//   the whole catalogue, including retired history and sessions staged by the
//   admin but not yet opened. Their state is returned as `status` /
//   `curriculumStatus` / `archived` flags so the UI can label them, and the
//   write routes refuse NEW content on archived lessons. Student visibility
//   rules (lifecycle PUBLISHED, track eligibility, progression) deliberately do
//   NOT apply here.
//
// AUTHORIZATION: TEACHER role; lessons are read through the teacher's own
// `Group.courseId` set — never through a client-supplied course id.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { lessonCoursesChainOr } from "@/lib/session-progress";
import { normalizeTrackScope } from "@/lib/track-scope";
import { teacherCourseIds } from "@/lib/teacher-content";

export async function GET(_req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const courseIds = teacherCourseIds(teacher);
  if (courseIds.length === 0) return ok({ lessons: [], grouped: [] });

  // Both curriculum chains: official lessons are unit-linked (topic null) and
  // must appear in the selector. No archived exclusion here — teachers manage
  // the full catalogue, including retired history.
  const lessons = await db.lesson.findMany({
    where: { OR: lessonCoursesChainOr(courseIds) },
    orderBy: [{ order: "asc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      titleAr: true,
      order: true,
      officialCode: true,
      trackScope: true,
      status: true,
      curriculumStatus: true,
      unitId: true,
      topicId: true,
      unit: {
        select: {
          id: true,
          title: true,
          titleAr: true,
          order: true,
          part: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              order: true,
              course: { select: { id: true, name: true, nameAr: true } },
            },
          },
        },
      },
      topic: {
        select: {
          id: true,
          title: true,
          titleAr: true,
          order: true,
          unit: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              order: true,
              part: {
                select: {
                  id: true,
                  title: true,
                  titleAr: true,
                  order: true,
                  course: { select: { id: true, name: true, nameAr: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  // Flat, deterministic list — the picker's authoritative payload. Answers,
  // for every lesson the teacher owns: which course/part/unit it belongs to,
  // under which chain, and what its track + lifecycle state are.
  const flat = lessons
    .map((l) => {
      const canonical = l.unit;
      const legacyUnit = l.topic?.unit ?? null;
      const unit = canonical ?? legacyUnit;
      const part = unit?.part ?? null;
      const course = part?.course ?? null;
      if (!unit || !part || !course) return null;
      return {
        id: l.id,
        title: l.titleAr || l.title,
        titleRaw: l.title,
        titleAr: l.titleAr,
        order: l.order,
        officialCode: l.officialCode,
        trackScope: normalizeTrackScope(l.trackScope) ?? "SHARED",
        status: l.status,
        curriculumStatus: l.curriculumStatus,
        archived: String(l.curriculumStatus).toUpperCase() === "ARCHIVED",
        /** Which chain attaches the lesson to its course (canonical first). */
        chain: canonical ? ("CANONICAL" as const) : ("LEGACY" as const),
        course: { id: course.id, name: course.nameAr || course.name },
        part: { id: part.id, title: part.titleAr || part.title, order: part.order },
        unit: { id: unit.id, title: unit.titleAr || unit.title, order: unit.order },
        topic: canonical || !l.topic ? null : { id: l.topic.id, title: l.topic.titleAr || l.topic.title },
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort(
      (a, b) =>
        a.course.id.localeCompare(b.course.id) ||
        a.part.order - b.part.order ||
        a.unit.order - b.unit.order ||
        a.order - b.order ||
        a.id.localeCompare(b.id)
    );

  // Grouped view for the tree UI: course → part → unit, with canonical
  // lessons directly under their unit and legacy topic-linked lessons under
  // their topic. The flat list above is the source of truth; this is the same
  // data arranged for rendering.
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
          order: number;
          units: Map<
            string,
            {
              id: string;
              title: string;
              titleAr: string;
              order: number;
              // Unit-linked (official) lessons live here; legacy topic
              // lessons stay under their topic below.
              lessons: Array<typeof flat[number]>;
              topics: Map<
                string,
                { id: string; title: string; titleAr: string; lessons: Array<typeof flat[number]> }
              >;
            }
          >;
        }
      >;
    }
  >();

  for (const entry of flat) {
    const courseId = entry.course.id;
    if (!byCourse.has(courseId)) {
      byCourse.set(courseId, { id: courseId, name: entry.course.name, parts: new Map() });
    }
    const c = byCourse.get(courseId)!;
    if (!c.parts.has(entry.part.id)) {
      c.parts.set(entry.part.id, {
        id: entry.part.id,
        title: entry.part.title,
        titleAr: entry.part.title,
        order: entry.part.order,
        units: new Map(),
      });
    }
    const p = c.parts.get(entry.part.id)!;
    if (!p.units.has(entry.unit.id)) {
      p.units.set(entry.unit.id, {
        id: entry.unit.id,
        title: entry.unit.title,
        titleAr: entry.unit.title,
        order: entry.unit.order,
        lessons: [],
        topics: new Map(),
      });
    }
    const u = p.units.get(entry.unit.id)!;
    if (!entry.topic) {
      // Unit-linked (official) lesson: listed directly under its unit.
      u.lessons.push(entry);
      continue;
    }
    if (!u.topics.has(entry.topic.id)) {
      u.topics.set(entry.topic.id, {
        id: entry.topic.id,
        title: entry.topic.title,
        titleAr: entry.topic.title,
        lessons: [],
      });
    }
    u.topics.get(entry.topic.id)!.lessons.push(entry);
  }

  const sortByOrder = <T extends { order: number; id: string }>(rows: T[]) =>
    rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const grouped = Array.from(byCourse.values())
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      parts: Array.from(c.parts.values())
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map((p) => ({
          id: p.id,
          title: p.title,
          titleAr: p.titleAr,
          units: Array.from(p.units.values())
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
            .map((u) => ({
              id: u.id,
              title: u.title,
              titleAr: u.titleAr,
              lessons: sortByOrder(u.lessons),
              topics: Array.from(u.topics.values())
                .sort((a, b) => a.id.localeCompare(b.id))
                .map((t) => ({
                  id: t.id,
                  title: t.title,
                  titleAr: t.titleAr,
                  lessons: sortByOrder(t.lessons),
                })),
            })),
        })),
    }));

  return ok({ lessons: flat, grouped });
}
