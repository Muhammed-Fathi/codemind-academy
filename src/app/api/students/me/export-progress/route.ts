import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Student: Export own progress as CSV
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { normalizeAcademicLevel } from "@/lib/academic-level";

/**
 * Phase M4.2 — COURSE / ACADEMIC-LEVEL ATTRIBUTION FOR EVERY ROW
 * =============================================================
 * This export is deliberately LIFETIME, not current-course: it is the student's
 * own history and is NOT silently narrowed (owner constraint). Because it spans
 * courses AND Academic Levels, every row must say WHICH course/level it belongs
 * to — otherwise two sessions that share a printed code and a title (the same
 * `officialCode` exists at both levels) would be indistinguishable in the file.
 *
 * Attribution is resolved from the canonical relation chains, never a label:
 *   Lesson / Quiz / Homework → the lesson chain (`Unit → Part → Course` first,
 *     the legacy `Topic → Unit → Part → Course` as the documented fallback)
 *     → `Course.academicLevel`;
 *   Attendance → `Session.group.course` (a Group belongs to exactly one course).
 *
 * `Level` carries the canonical enum value (`FIRST_SECONDARY` /
 * `SECOND_SECONDARY`) — locale-independent data, not a translated caption — and
 * stays EMPTY when no chain resolves, so a row never guesses a level. The
 * lesson's own denormalized `academicLevel` is used only as a last-resort
 * fallback when the chain is gone.
 */
type CourseChain = {
  id: string;
  name: string;
  nameAr: string;
  academicLevel: unknown;
} | null;

type LessonChainLike = {
  academicLevel?: unknown;
  unit?: { part?: { course?: unknown } | null } | null;
  topic?: { unit?: { part?: { course?: unknown } | null } | null } | null;
} | null;

/** Canonical-first course chain of a lesson (attribution only). */
function lessonChainCourse(lesson: LessonChainLike): CourseChain {
  const raw = lesson?.unit?.part?.course ?? lesson?.topic?.unit?.part?.course ?? null;
  const course = raw as
    | { id?: unknown; name?: unknown; nameAr?: unknown; academicLevel?: unknown }
    | null;
  if (!course || typeof course.id !== "string") return null;
  return {
    id: course.id,
    name: String(course.name ?? ""),
    nameAr: String(course.nameAr ?? course.name ?? ""),
    academicLevel: course.academicLevel ?? null,
  };
}

/** `[course, canonical level]` captions for one row; empty strings = unknown. */
function attribution(
  course: CourseChain,
  fallbackLevel?: unknown
): [string, string] {
  const level = normalizeAcademicLevel(course?.academicLevel ?? fallbackLevel);
  return [course ? course.nameAr || course.name : "", level ?? ""];
}

export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.132"), 403);

  const student = await db.student.findUnique({
    where: { userId: user.id },
    include: {
      user: { select: { name: true, email: true } },
      group: { select: { name: true, course: { select: { nameAr: true } } } },
      attendances: {
        include: {
          session: {
            select: {
              titleAr: true,
              title: true,
              startAt: true,
              // M4.2 — an attendance row is attributed through its Group.
              group: {
                select: {
                  id: true,
                  course: {
                    select: { id: true, name: true, nameAr: true, academicLevel: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      },
      quizAttempts: {
        include: {
          quiz: {
            select: {
              titleAr: true,
              title: true,
              lesson: {
                select: {
                  titleAr: true,
                  academicLevel: true,
                  unit: { select: { part: { select: { course: { select: { id: true, name: true, nameAr: true, academicLevel: true } } } } } },
                  topic: { select: { unit: { select: { part: { select: { course: { select: { id: true, name: true, nameAr: true, academicLevel: true } } } } } } } },
                },
              },
            },
          },
        },
        orderBy: { finishedAt: "desc" },
      },
      homeworkSubmits: {
        include: {
          homework: {
            select: {
              titleAr: true,
              title: true,
              lesson: {
                select: {
                  titleAr: true,
                  academicLevel: true,
                  unit: { select: { part: { select: { course: { select: { id: true, name: true, nameAr: true, academicLevel: true } } } } } },
                  topic: { select: { unit: { select: { part: { select: { course: { select: { id: true, name: true, nameAr: true, academicLevel: true } } } } } } } },
                },
              },
            },
          },
        },
        orderBy: { submittedAt: "desc" },
      },
      lessonProgress: {
        // Phase 19: official lessons are UNIT-linked (topicId = null) — the
        // CSV's "Topic/Lesson" column fell permanently blank for them. The
        // unit title now travels as the canonical fallback.
        include: {
          lesson: {
            select: {
              titleAr: true,
              title: true,
              academicLevel: true,
              // M4.2 — the same `unit` / `topic` relations now also carry the
              // course chain, so the row is attributable to its course/level.
              topic: {
                select: {
                  titleAr: true,
                  title: true,
                  unit: { select: { part: { select: { course: { select: { id: true, name: true, nameAr: true, academicLevel: true } } } } } },
                },
              },
              unit: {
                select: {
                  titleAr: true,
                  title: true,
                  part: { select: { course: { select: { id: true, name: true, nameAr: true, academicLevel: true } } } },
                },
              },
            },
          },
        },
        orderBy: { lastViewedAt: "desc" },
      },
    },
  });
  if (!student) return err(tApi("api.133"), 404);

  // The six original columns keep their order; `Course` + `Level` are APPENDED
  // so every row stays attributable to its course/level without reordering a
  // column any consumer may already parse.
  const headers = [
    "Type",
    "Title",
    "Topic/Lesson",
    "Date",
    "Score/Status",
    "Details",
    "Course",
    "Level",
  ];

  const rows: any[] = [];

  // Lessons
  student.lessonProgress.forEach((lp) => {
    const [courseName, level] = attribution(
      lessonChainCourse(lp.lesson),
      lp.lesson.academicLevel
    );
    rows.push([
      "Lesson",
      lp.lesson.titleAr || lp.lesson.title,
      // Canonical curriculum group: topic for legacy rows, unit for official.
      lp.lesson.topic?.titleAr ||
        lp.lesson.topic?.title ||
        lp.lesson.unit?.titleAr ||
        lp.lesson.unit?.title ||
        "",
      lp.lastViewedAt ? lp.lastViewedAt.toLocaleDateString("en-GB") : "",
      lp.isCompleted ? "Completed" : "In Progress",
      `${lp.progress}%`,
      courseName,
      level,
    ]);
  });

  // Quizzes
  student.quizAttempts.forEach((qa) => {
    const [courseName, level] = attribution(
      lessonChainCourse(qa.quiz?.lesson ?? null),
      qa.quiz?.lesson?.academicLevel
    );
    rows.push([
      "Quiz",
      qa.quiz?.titleAr || qa.quiz?.title || "",
      qa.quiz?.lesson?.titleAr || "",
      qa.finishedAt ? qa.finishedAt.toLocaleDateString("en-GB") : "",
      qa.passed ? "Passed" : "Failed",
      `${qa.percentage}% (${qa.score}/${qa.totalMarks})`,
      courseName,
      level,
    ]);
  });

  // Homework
  student.homeworkSubmits.forEach((hw) => {
    const [courseName, level] = attribution(
      lessonChainCourse(hw.homework?.lesson ?? null),
      hw.homework?.lesson?.academicLevel
    );
    rows.push([
      "Homework",
      hw.homework?.titleAr || hw.homework?.title || "",
      hw.homework?.lesson?.titleAr || "",
      hw.submittedAt ? hw.submittedAt.toLocaleDateString("en-GB") : "",
      hw.status,
      hw.grade ? `${hw.grade}/10` : "",
      courseName,
      level,
    ]);
  });

  // Attendance
  student.attendances.forEach((att) => {
    // A session belongs to the GROUP it was scheduled for, and a group belongs
    // to one course — that relation (not the student's CURRENT group) is what
    // makes an old attendance row attributable to the right course/level.
    const groupCourse = att.session?.group?.course ?? null;
    const [courseName, level] = attribution(
      groupCourse
        ? {
            id: String(groupCourse.id ?? ""),
            name: String(groupCourse.name ?? ""),
            nameAr: String(groupCourse.nameAr ?? groupCourse.name ?? ""),
            academicLevel: groupCourse.academicLevel ?? null,
          }
        : null
    );
    rows.push([
      "Attendance",
      att.session?.titleAr || att.session?.title || "",
      "",
      att.session?.startAt ? att.session.startAt.toLocaleDateString("en-GB") : "",
      att.status,
      att.note || "",
      courseName,
      level,
    ]);
  });

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  return new NextResponse("\uFEFF" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      // Phase 26B fix: `user.name` is an Arabic three-part name for every
      // real student (registration enforces it), and Node's HTTP layer
      // rejects non-latin1 header VALUES — the raw name in `filename` made
      // this endpoint throw for the entire product. The ASCII-legal fallback
      // keeps the plain `filename` usable everywhere, and the RFC 5987
      // `filename*` parameter preserves the student's real (UTF-8) name.
      "Content-Disposition": (() => {
        const date = new Date().toISOString().slice(0, 10);
        const asciiName =
          user.name
            .replace(/[^\x20-\x7E]/g, "")
            .replace(/\s/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "progress";
        const utf8Name = `my-progress-${user.name.replace(/\s/g, "-")}-${date}.csv`;
        return `attachment; filename="my-progress-${asciiName}-${date}.csv"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;
      })(),
    },
  });
}
