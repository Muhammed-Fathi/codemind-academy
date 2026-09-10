import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import {
  canAccessLesson,
  EXCLUDE_ARCHIVED_LESSON,
  LESSON_CHAIN_SELECT,
  lessonCourseChainOr,
  orderCourseLessons,
  resolveLessonCourseId,
} from "@/lib/session-progress";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { safeParseOptions } from "@/lib/session-quiz";
import {
  getParentTrackScopes,
  isParentLessonPreviewAllowed,
} from "@/lib/parent-access";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import {
  eligibleTrackScopes,
  trackScopeInWhere,
  trackScopeWhere,
} from "@/lib/track-scope";
import { getStudentSchoolType } from "@/lib/enrollment";
import { buildMaterialDescriptors } from "@/lib/session-materials";

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

  // Phase 12 — the viewer's TRACK SLICE, resolved once from server-side state
  // and reused for (a) the quizzes/homeworks listed on the lesson and (b) the
  // prev/next chain. Both must use the same slice the progression engine uses,
  // otherwise the page would name a quiz or a "next session" the student can
  // never open. Teachers/admins are unrestricted: they manage every scope.
  // Phase 14 — the same slice filters materials.
  let viewerTrackFilter: object = {};
  let viewerEligibleScopes: import("@/lib/track-scope").TrackScope[] | null = null;
  if (user.role === "STUDENT") {
    const viewer = await db.student.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    const schoolType = viewer ? await getStudentSchoolType(viewer.id) : null;
    viewerTrackFilter = trackScopeWhere(schoolType);
    viewerEligibleScopes = eligibleTrackScopes(schoolType);
  } else if (user.role === "PARENT") {
    const scopes = await getParentTrackScopes(user.id);
    viewerTrackFilter = trackScopeInWhere(scopes);
    viewerEligibleScopes = [...scopes];
  }

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
        where: { ...viewerTrackFilter },
        orderBy: [{ order: "asc" }, { id: "asc" }],
        include: { questions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
      },
      homeworks: { where: { ...viewerTrackFilter }, orderBy: { deadline: "asc" } },
      // Phase 14 — active materials only, with media metadata for descriptors.
      // storageKey is deliberately NOT selected.
      materials: {
        where: {
          isActive: true,
          ...(Object.keys(viewerTrackFilter).length
            ? viewerTrackFilter
            : {}),
        },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          kind: true,
          trackScope: true,
          isActive: true,
          mediaAssetId: true,
          media: {
            select: { mimeType: true, sizeBytes: true },
          },
        },
      },
    },
  });
  if (!lesson) return err("Lesson not found", 404);

  // Canonical chain first; legacy topic chain as fallback.
  const chainPart = lesson.unit?.part ?? lesson.topic?.unit.part ?? null;
  const chainUnit = lesson.unit ?? lesson.topic?.unit ?? null;
  const chainCourse = lesson.unit?.part.course ?? lesson.topic?.unit.part.course ?? null;

  // Phase 7: a parent may open ONLY lessons of courses in which a linked
  // child is enrolled. Lesson ids are unguessable, so an out-of-scope lesson
  // looks exactly like a nonexistent one (404) — the response never confirms
  // that the id is real. (Whether an in-scope parent sees quiz answers stays
  // governed by the documented Phase 1 `revealQuizAnswers` rule below.)
  //
  // Phase 13 CLOSES the parent gap the Phase 12 report recorded as Finding 2:
  // the parent branch checked the COURSE and the TRACK but never the
  // LIFECYCLE, so an in-scope parent could open a lesson an admin had staged
  // and not published — reading its body, its quiz questions and its video/PDF
  // urls, i.e. the very content the child cannot see. A parent previews what a
  // child is allowed to see, and a child's curriculum is by definition the
  // PUBLISHED, non-archived slice, so "parent preview" is not a publication
  // bypass. The three clauses now live in ONE helper
  // (`isParentLessonPreviewAllowed`) shared with the quiz surface, so they
  // cannot drift apart.
  if (user.role === "PARENT") {
    const allowed = await isParentLessonPreviewAllowed(
      user.id,
      {
        status: lesson.status,
        curriculumStatus: lesson.curriculumStatus,
        trackScope: lesson.trackScope,
      },
      chainCourse?.id
    );
    if (!allowed) return err("Lesson not found", 404);
  }

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
    // Prev/next navigate the ACTIVE curriculum only: archived lessons are
    // history, and the chain must never strand a student on (or hop over to)
    // a session the engine no longer teaches.
    //
    // Phase 12 — and only the viewer's own TRACK (`viewerTrackFilter`,
    // resolved above). Without this, "next" would hand an ARABIC student the
    // id of a LANGUAGE session (and vice versa), which is both a cross-track
    // pointer and a progression hole. The slice matches the one
    // `getCourseSessionProgress` uses, so the navigation chain and the unlock
    // chain are the same sequence.
    const found = await db.lesson.findMany({
      where: {
        // Phase 13: the chain walks the STUDENT curriculum (PUBLISHED only),
        // in place of the legacy `isPublished` flag — the same predicate the
        // progression universe uses, so "next session" is always a session the
        // engine can actually gate. Prev/next never hops to a DRAFT/READY
        // sibling for any viewer, staff included: the alternative is a second
        // ordering rule for staging, which is exactly the drift Phase 13
        // removes.
        ...LESSON_STUDENT_STATUS_FILTER,
        ...EXCLUDE_ARCHIVED_LESSON,
        ...viewerTrackFilter,
        OR: lessonCourseChainOr(courseId),
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

  // Phase 14 — material descriptors replace raw pdfUrl for new delivery.
  // Legacy pdfUrl is still returned as a READ-ONLY compatibility field when
  // no Material rows exist; new uploads never write it. Descriptors never
  // include storageKey or filesystem paths.
  const materials = buildMaterialDescriptors({
    materials: lesson.materials,
    legacyPdfUrl: lesson.pdfUrl,
    includeProtected: true, // access already gated above for students
    eligibleScopes: viewerEligibleScopes,
  });
  // Back-compat: the first downloadable material's URL (authorized path or
  // legacy external URL). Prefer Material descriptors; fall back to legacy.
  const primaryPdf =
    materials.find((m) => m.downloadUrl && !m.legacy)?.downloadUrl ??
    materials.find((m) => m.legacy)?.downloadUrl ??
    null;

  return ok({
    lesson: {
      id: lesson.id,
      title: lesson.title,
      titleAr: lesson.titleAr,
      // Phase 16 — official session identity (1-1..7-3). Skeleton metadata,
      // safe to serialise on every response of this route: reaching this
      // point already passed the lifecycle / track / progression gates above.
      officialCode: lesson.officialCode ?? null,
      description: lesson.description,
      summary: lesson.summary,
      duration: lesson.duration,
      order: lesson.order,
      videoUrl: lesson.videoUrl,
      // Phase 14: prefer the authorized material path. Legacy external URLs
      // remain only when no Material exists. NEVER a storageKey / filesystem path.
      pdfUrl: primaryPdf,
      materials,
      // Phase 13: the retired `isLocked` column is no longer serialised.
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
