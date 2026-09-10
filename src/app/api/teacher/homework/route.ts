// /api/teacher/homework
//
//   GET  — every assignment of the teacher's own courses, with submissions,
//          grades and status counts (management surface).
//   POST — Phase 18: CREATE an assignment on one of the teacher's own lessons.
//
// AUTHORIZATION (every path): authenticated → TEACHER role → the teacher's own
// courses (resolved from `Group.courseId`, never from the request) → the lesson
// belongs to one of those courses through the CANONICAL
// `Course → Part → Unit → Lesson` chain, with the legacy Topic chain only as a
// fallback → the requested track scope is compatible with the lesson's.
//
// The GET deliberately does NOT apply student visibility rules: a DRAFT lesson
// and an ARCHIVED lesson both stay in the teacher's list, because a pending
// legacy submission still has to be graded and a teacher manages the whole
// catalogue. Lifecycle and archive state are RETURNED (never filtered) so the
// UI can label them.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { lessonCoursesChainOr } from "@/lib/session-progress";
import { resolveContentTrackScope } from "@/lib/track-scope";
import {
  TEACHER_LIMITS,
  boundedText,
  isArchivedLesson,
  lessonTrackScope,
  loadOwnedLesson,
  parseDeadline,
  teacherCourseIds,
} from "@/lib/teacher-content";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const url = new URL(req.url);
  const groupId = url.searchParams.get("groupId") || "";
  const courseIds = teacher.groups
    .filter((g) => !groupId || g.id === groupId)
    .map((g) => g.courseId);

  if (courseIds.length === 0) return ok({ homework: [] });

  // Both curriculum chains: homework on unit-linked (official) lessons must
  // be listed too. No archived exclusion — a pending legacy submission still
  // needs grading, and teachers manage the full catalogue.
  const lessons = await db.lesson.findMany({
    where: { OR: lessonCoursesChainOr(courseIds) },
    select: { id: true },
  });
  const lessonIds = lessons.map((l) => l.id);

  const homework = lessonIds.length
    ? await db.homework.findMany({
        where: { lessonId: { in: lessonIds } },
        orderBy: [{ deadline: "asc" }, { id: "asc" }],
        include: {
          lesson: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              officialCode: true,
              trackScope: true,
              status: true,
              curriculumStatus: true,
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
              topic: {
                select: {
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
          },
          submissions: {
            orderBy: { id: "asc" },
            include: {
              student: {
                include: {
                  user: { select: { name: true, email: true, avatarUrl: true } },
                },
              },
            },
          },
        },
      })
    : [];

  // Group students for each homework's group (the lesson course may have
  // multiple groups). We compute per-homework stats:
  //   - total students in course groups
  //   - submittedCount, gradedCount, pendingCount
  const homeworkPayload = homework.map((hw) => {
    const submitted = hw.submissions.filter(
      (s) => s.status === "SUBMITTED" || s.status === "GRADED" || s.status === "LATE"
    ).length;
    const graded = hw.submissions.filter((s) => s.status === "GRADED").length;
    const pending = hw.submissions.filter((s) => s.status === "PENDING").length;
    // Canonical chain first; legacy topic chain as fallback.
    const hwUnit = hw.lesson?.unit ?? hw.lesson?.topic?.unit ?? null;
    const hwPart = hwUnit?.part ?? null;
    const hwCourse = hwPart?.course ?? null;
    return {
      id: hw.id,
      title: hw.titleAr || hw.title,
      titleAr: hw.titleAr,
      titleRaw: hw.title,
      instructions: hw.instructions,
      deadline: hw.deadline,
      maxMarks: hw.maxMarks,
      trackScope: hw.trackScope,
      createdAt: hw.createdAt,
      // How many of the submissions already carry a grade — the UI uses it to
      // disable a destructive edit instead of discovering it from a 409.
      gradedCount: graded,
      lesson: hw.lesson
        ? {
            id: hw.lesson.id,
            title: hw.lesson.titleAr || hw.lesson.title,
            titleRaw: hw.lesson.title,
            officialCode: hw.lesson.officialCode,
            trackScope: hw.lesson.trackScope,
            status: hw.lesson.status,
            curriculumStatus: hw.lesson.curriculumStatus,
            chain: hw.lesson.unit ? "CANONICAL" : hw.lesson.topic ? "LEGACY" : null,
            part: hwPart
              ? { id: hwPart.id, title: hwPart.titleAr || hwPart.title }
              : null,
            unit: hwUnit
              ? { id: hwUnit.id, title: hwUnit.titleAr || hwUnit.title }
              : null,
            course: hwCourse
              ? {
                  id: hwCourse.id,
                  name: hwCourse.nameAr || hwCourse.name,
                }
              : null,
          }
        : null,
      stats: {
        submitted,
        graded,
        pending,
        totalSubmissions: hw.submissions.length,
      },
      submissions: hw.submissions.map((s) => ({
        id: s.id,
        status: s.status,
        content: s.content,
        fileUrl: s.fileUrl,
        submittedAt: s.submittedAt,
        grade: s.grade,
        feedback: s.feedback,
        student: {
          id: s.student.id,
          name: s.student.user.name,
          email: s.student.user.email,
          avatarUrl: s.student.user.avatarUrl,
          grade: s.student.grade,
        },
      })),
    };
  });

  return ok({ homework: homeworkPayload });
}

// POST /api/teacher/homework
// Body: { lessonId, title, titleAr?, instructions, deadline, maxMarks?,
//         trackScope? }
//
// Deterministic validation, in this order (so the same bad payload always
// produces the same response):
//   role → teacher profile → lessonId → title → instructions → deadline →
//   maxMarks → track scope → lesson ownership → archived guard → create.
//
// The lesson's course is resolved CANONICALLY FIRST. Only a lesson the teacher
// owns can receive the assignment: a teacher can never create homework under
// another teacher's course, and a real lesson id from someone else's course is
// a 403 (not a 404) because the lesson's existence is not a secret from staff.
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const body = await req.json().catch(() => ({}));

  const lessonId = String(body.lessonId || "").trim();
  if (!lessonId) return err(tApi("api.176"), 400);

  const title = boundedText(body.title, TEACHER_LIMITS.TITLE_MAX, {
    required: true,
  });
  if (!title.ok || !title.value) return err(tApi("api.234"), 400);

  const titleAr = boundedText(body.titleAr, TEACHER_LIMITS.TITLE_AR_MAX);
  if (!titleAr.ok) return err(tApi("api.234"), 400);

  // `instructions` is what makes an assignment actionable — the readiness
  // ceremony refuses a homework without them (admin.437), so creating one is
  // refused here rather than queuing a session that can never be published.
  const instructions = boundedText(
    body.instructions,
    TEACHER_LIMITS.INSTRUCTIONS_MAX,
    { required: true }
  );
  if (!instructions.ok || !instructions.value) {
    return err(tApi("api.237", { p1: TEACHER_LIMITS.INSTRUCTIONS_MAX }), 400);
  }

  const deadline = parseDeadline(body.deadline);
  if (!deadline) return err(tApi("api.235"), 400);

  const maxMarksRaw = Number(body.maxMarks ?? 10);
  if (
    !Number.isInteger(maxMarksRaw) ||
    maxMarksRaw < TEACHER_LIMITS.MARKS_MIN ||
    maxMarksRaw > TEACHER_LIMITS.MARKS_MAX
  ) {
    return err(
      tApi("api.236", {
        p1: TEACHER_LIMITS.MARKS_MIN,
        p2: TEACHER_LIMITS.MARKS_MAX,
      }),
      400
    );
  }

  // Ownership BEFORE the track-scope decision: a teacher probing another
  // teacher's lesson must learn nothing about its scope or lifecycle.
  const owned = await loadOwnedLesson(lessonId, teacherCourseIds(teacher));
  if (!owned.ok) return err(tApi("api.179"), owned.status);

  if (isArchivedLesson(owned.lesson)) {
    return err(tApi("api.242"), 409);
  }

  // Track scope: explicit value must be contained by the lesson's scope; an
  // absent value INHERITS the lesson's scope (never SHARED by omission).
  const scope = resolveContentTrackScope(
    body.trackScope,
    lessonTrackScope(owned.lesson)
  );
  if (!scope.ok) {
    return err(
      scope.reason === "OUT_OF_LESSON_SCOPE" ? tApi("api.243") : tApi("api.228"),
      400
    );
  }

  const created = await db.homework.create({
    data: {
      lessonId,
      title: title.value,
      titleAr: titleAr.value ?? title.value,
      instructions: instructions.value,
      deadline,
      maxMarks: maxMarksRaw,
      trackScope: scope.scope,
    },
  });

  return ok({
    homework: {
      id: created.id,
      lessonId: created.lessonId,
      title: created.title,
      titleAr: created.titleAr,
      instructions: created.instructions,
      deadline: created.deadline,
      maxMarks: created.maxMarks,
      trackScope: created.trackScope,
      createdAt: created.createdAt,
      /** True when the scope came from the lesson rather than the request. */
      trackScopeInherited: scope.inherited,
      lesson: {
        id: owned.lesson.id,
        officialCode: owned.lesson.officialCode,
        title: owned.placement.unitTitle,
        part: owned.placement.partTitle,
        course: owned.placement.courseName,
        chain: owned.placement.chain,
        trackScope: lessonTrackScope(owned.lesson),
        status: owned.lesson.status,
        curriculumStatus: owned.lesson.curriculumStatus,
      },
    },
  });
}
