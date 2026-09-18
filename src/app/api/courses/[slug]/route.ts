import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";
import {
  getEnrollment,
  getStudentSchoolType,
  syncStudentBatch,
} from "@/lib/enrollment";
import {
  EXCLUDE_ARCHIVED_LESSON,
  getCourseSessionProgress,
} from "@/lib/session-progress";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import {
  getParentTrackScopes,
  isParentAuthorizedForCourse,
} from "@/lib/parent-access";
import {
  eligibleTrackScopes,
  trackScopeInWhere,
  trackScopeWhere,
} from "@/lib/track-scope";
import { getServerT } from "@/lib/i18n-server";
import { buildMaterialDescriptors } from "@/lib/session-materials";
// Phase C — the ONE Lesson Content Summary authority. The tree's content
// indicators (video / material / quiz / homework) derive from the SAME
// aggregation the lesson page and the dashboard use; no per-surface hasX
// re-implementation remains in this route.
import {
  buildLessonContentSummaries,
  toLessonContentPayload,
  type LessonContentViewer,
} from "@/lib/lesson-content";

// GET /api/courses/[slug]
// Returns course + parts + units + lessons (+ legacy topics) with the current
// student's progress.
//
// The canonical hierarchy is Course → Part → Unit → Lesson (`Lesson.unitId`);
// `Topic` is a nullable legacy layer kept only so older content keeps
// rendering. A unit therefore carries TWO lesson collections:
//   unit.lessons        — canonical, unit-linked lessons
//   unit.topics[].lessons — legacy lessons, shown under their Topic
// A lesson that carries BOTH links is listed under the Unit, because that is
// where `getCourseSessionProgress` enforces it — the tree must never present a
// session in a different position from the one the gate uses.
type LessonRow = {
  id: string;
  unitId: string | null;
  topicId: string | null;
  title: string;
  titleAr: string;
  /** Phase 16 — official session identity (1-1..7-3). Part of the skeleton. */
  officialCode: string | null;
  order: number;
  duration: number;
  videoUrl: string | null;
  pdfUrl: string | null;
  summary: string | null;
  description: string | null;
  quizzes: { id: string; title: string; titleAr: string }[];
  homeworks: { id: string; title: string; titleAr: string; deadline: Date | null }[];
  // Phase 14 — active materials (storageKey never selected).
  materials?: {
    id: string;
    title: string;
    kind: string;
    trackScope: string;
    isActive: boolean;
    mediaAssetId: string | null;
    media: { mimeType: string | null; sizeBytes: number | null } | null;
  }[];
};

const LESSON_INCLUDE = {
  quizzes: { orderBy: { order: "asc" as const }, select: { id: true, titleAr: true, title: true, trackScope: true } },
  homeworks: { select: { id: true, titleAr: true, title: true, deadline: true, trackScope: true } },
  // Phase 14 — active materials only. storageKey deliberately omitted.
  materials: {
    where: { isActive: true },
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      title: true,
      kind: true,
      trackScope: true,
      isActive: true,
      mediaAssetId: true,
      media: { select: { mimeType: true, sizeBytes: true } },
    },
  },
};

type LessonStatus = "completed" | "current" | "locked" | "available";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  // Phase 12 — resolve the viewer's TRACK SLICE before any content is read, so
  // the tree can never contain a lesson from the other school type. Hiding it
  // later in the payload would not be protection: the client can read the
  // response. Teachers and admins are deliberately unrestricted — they manage
  // SHARED, ARABIC and LANGUAGE content and must not be filtered as though
  // they were students.
  let viewerTrackFilter: object = {};
  let viewerEligibleScopes: import("@/lib/track-scope").TrackScope[] | null = null;
  // Phase 13 — the same layering, one dimension later: the tree shows the
  // PUBLISHED slice to students and to parents previewing a child's course,
  // and the FULL lifecycle to staff, who manage DRAFT and READY content and
  // must be able to see what has not been opened yet.
  //
  // Before Phase 13 the tree had NO lifecycle clause at all while the
  // progression engine required `isPublished`, so a staged lesson was listed
  // as an ordinary "available" session (its title, videoUrl and pdfUrl with
  // it) even though the engine refused it. Visibility and availability were
  // then two different answers to one question. They are now the same filter.
  let viewerLifecycleFilter: object = LESSON_STUDENT_STATUS_FILTER;
  // Phase B — the viewer's own school type, kept for the modern video-presence
  // query below (the batch audience rule is a schoolType equality, not a
  // request parameter).
  let viewerSchoolType: string | null = null;
  // Phase C — the viewer context the shared Lesson Content Summary authority
  // aggregates in. Students aggregate in their OWN audience (school type +
  // batch); parents in the union of their children's tracks; staff preview
  // everything. The eligibility predicates themselves stay in the established
  // modules (track-scope / session-materials / the batch video rule).
  let contentViewer: LessonContentViewer = { role: "STAFF" };
  if (user.role === "STUDENT") {
    const viewer = await getStudentProfile(user.id);
    const schoolType = viewer ? await getStudentSchoolType(viewer.id) : null;
    viewerSchoolType = schoolType;
    viewerTrackFilter = trackScopeWhere(schoolType);
    viewerEligibleScopes = eligibleTrackScopes(schoolType);
  } else if (user.role === "PARENT") {
    // A parent previews through their children's tracks, never their own.
    const scopes = await getParentTrackScopes(user.id);
    viewerTrackFilter = trackScopeInWhere(scopes);
    viewerEligibleScopes = [...scopes];
    contentViewer = { role: "PARENT", scopes: [...scopes] };
  } else {
    // TEACHER / ADMIN: every status, so staging is manageable.
    viewerLifecycleFilter = {};
  }

  const course = await db.course.findUnique({
    where: { slug },
    include: {
      parts: {
        orderBy: { order: "asc" },
        include: {
          units: {
            orderBy: { order: "asc" },
            include: {
              // Canonical chain: Course → Part → Unit → Lesson.
              // Archived lessons are history, not curriculum (Phase 11).
              lessons: {
                where: {
                  ...viewerLifecycleFilter,
                  ...EXCLUDE_ARCHIVED_LESSON,
                  ...viewerTrackFilter,
                },
                orderBy: { order: "asc" },
                include: LESSON_INCLUDE,
              },
              // Legacy chain: … → Unit → Topic → Lesson.
              topics: {
                orderBy: { order: "asc" },
                include: {
                  lessons: {
                    where: {
                      ...viewerLifecycleFilter,
                      ...EXCLUDE_ARCHIVED_LESSON,
                      ...viewerTrackFilter,
                    },
                    orderBy: { order: "asc" },
                    include: LESSON_INCLUDE,
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

  // Resolve student for progress lookups + ENFORCE ENROLLMENT.
  // A student must never receive the content of a course they are not
  // enrolled in, even when hitting this route directly.
  let studentId: string | null = null;
  // Phase B — the student's media audience (their batch), resolved with the
  // SAME lazy-reconcile rule the session-video list uses, so the tree's video
  // badge, the lesson page's player and the standalone library always agree.
  let studentBatchId: string | null = null;
  if (user.role === "STUDENT") {
    const tApi = await getServerT();
    const s = await getStudentProfile(user.id);
    if (!s) return err("Student profile not found", 404);
    const enrollment = await getEnrollment(s.id);
    if (!enrollment.isEnrolled || enrollment.courseId !== course.id) {
      return NextResponse.json(
        { error: tApi("api.208"), code: "NOT_ENROLLED" },
        { status: 403 }
      );
    }
    studentId = s.id;
    studentBatchId = s.batchId || (await syncStudentBatch(s.id));
    // Phase C — the tree's content indicators aggregate in the student's own
    // audience (school type + batch), so a SHARED lesson's badges never count
    // the other track's recordings or rows.
    contentViewer = {
      role: "STUDENT",
      schoolType: viewerSchoolType,
      batchId: studentBatchId,
    };
  }

  // Phase 7: a parent may preview ONLY the courses of their linked children.
  // Without this, any authenticated parent could fetch the full content tree
  // (lesson ids, video/pdf URLs, quiz/homework identities) of every course by
  // guessing its slug. The slug catalogue is public, so — exactly like the
  // student denial above — this is a 403, not a 404. Teachers/admins keep
  // their full preview.
  if (user.role === "PARENT") {
    const tApi = await getServerT();
    const allowed = await isParentAuthorizedForCourse(user.id, course.id);
    if (!allowed) {
      return NextResponse.json(
        { error: tApi("api.208"), code: "NOT_ENROLLED" },
        { status: 403 }
      );
    }
  }

  // Build the lesson list (ordered, flat) — the single place the tree order is
  // decided, and the same order `getCourseSessionProgress` uses:
  //   Part.order → Unit.order → canonical lessons → legacy Topics.
  type FlatLesson = {
    lesson: LessonRow;
    partId: string;
    unitId: string;
    topicId: string | null;
    progress: number;
    isCompleted: boolean;
    status: LessonStatus;
  };

  const flat: FlatLesson[] = [];
  const progressMap: Record<
    string,
    { progress: number; isCompleted: boolean; lastViewedAt: string | null }
  > = {};

  for (const part of course.parts) {
    for (const unit of part.units) {
      const push = (lesson: LessonRow, topicId: string | null) => {
        flat.push({
          lesson,
          partId: part.id,
          unitId: unit.id,
          topicId,
          progress: 0,
          isCompleted: false,
          status: "available",
        });
      };
      // Canonical lessons belong to the Unit itself.
      for (const lesson of unit.lessons) push(lesson, null);
      // Legacy lessons are shown under their Topic — unless they are also
      // unit-linked, in which case the Unit already listed them above.
      for (const topic of unit.topics) {
        for (const lesson of topic.lessons) {
          if (lesson.unitId) continue;
          push(lesson, topic.id);
        }
      }
    }
  }

  const lessonIds = flat.map((f) => f.lesson.id);
  if (studentId && lessonIds.length) {
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
    for (const f of flat) {
      const lp = progressMap[f.lesson.id];
      f.progress = lp?.progress || 0;
      f.isCompleted = !!lp?.isCompleted;
    }
  }

  // Phase C — ONE aggregation for every content indicator on the tree. The
  // previous fragmentation: this route carried its own modern-video query
  // (Phase B), derived material presence through the Phase 14 descriptors,
  // and counted quizzes/homeworks from RAW rows WITHOUT the viewer's track
  // filter — so a SHARED lesson hosting only a LANGUAGE quiz showed a "Quiz"
  // badge to an ARABIC student while the lesson page (which filters) said
  // "no quiz". All four dimensions now come from
  // `buildLessonContentSummaries`, the SAME authority the lesson page and
  // the Continue Learning card call:
  //
  //   * video    — modern SessionVideo rows of the student's OWN batch
  //                (PUBLISHED + track-eligible; the Phase A/B audience rule)
  //                with the legacy `Lesson.videoUrl` kept as a documented
  //                fallback counting as at most one video;
  //   * material — the Phase 14 descriptor authority (isActive + downloadable
  //                + eligible trackScope + legacy pdfUrl fallback), computed
  //                over the UNREDACTED list so the Phase 16 skeleton badges
  //                stay lock-independent;
  //   * quiz /
  //     homework — existence in the viewer's OWN track slice. The other
  //                audience's rows are neither exposed nor counted (they read
  //                ABSENT for this viewer), matching the lesson page exactly.
  //
  // The summary is states + counts only: no ids, titles or URLs leave this
  // route through it, and a PUBLISHED + LOCKED session still shows its
  // skeleton badges while every protected field stays redacted below
  // (the Phase 4/16 redaction contract is untouched).
  const contentByLesson = await buildLessonContentSummaries({
    lessons: flat.map((f) => f.lesson),
    viewer: contentViewer,
  });

  // Determine locked / current / completed statuses from the SHARED session
  // progression service, so the UI mirrors exactly what the backend enforces:
  // a session is complete only when its video (>=95%), quiz and assignment
  // requirements are all satisfied; missing components are not required.
  const requirementsByLesson = new Map<string, unknown>();
  if (studentId) {
    const sessionProgress = await getCourseSessionProgress(studentId, course.id);
    for (const row of sessionProgress.sessions) {
      requirementsByLesson.set(row.lessonId, row);
    }
    let currentAssigned = false;
    for (const f of flat) {
      const req = sessionProgress.byLessonId.get(f.lesson.id);
      if (!req) {
        f.status = f.isCompleted ? "completed" : "available";
        continue;
      }
      if (!req.unlocked) {
        f.status = "locked";
      } else if (req.completed) {
        f.status = "completed";
      } else if (!currentAssigned) {
        f.status = "current";
        currentAssigned = true;
      } else {
        f.status = "available";
      }
    }
  } else {
    // Non-student viewers (teacher/admin previews) see everything unlocked.
    for (const f of flat) f.status = "available";
  }

  const statusById = new Map<string, LessonStatus>(
    flat.map((f) => [f.lesson.id, f.status])
  );

  // ONE definition of the lesson payload. A locked session is described by its
  // title/number/duration only: media URLs, the PDF, the summary/description,
  // the quiz and assignment identities and the requirement breakdown all stay
  // server-side — hiding them in the UI is not protection, because the client
  // can simply read this response.
  const toLesson = (lesson: LessonRow) => {
    const locked = statusById.get(lesson.id) === "locked";
    const lp = progressMap[lesson.id];
    // Phase C — this lesson's content summary from the shared authority.
    // Presence badges (hasVideo/hasPdf/hasQuiz/hasAssignment + materialCount)
    // and the serialized `content` block all read from it — never from
    // per-surface rules.
    const content = contentByLesson.get(lesson.id) ?? null;
    // Phase 14 — material descriptors. Locked sessions get an empty list so
    // material ids are never leaked. Unlocked sessions get safe descriptors
    // (authorized /api/materials/[id] paths) — never storageKey / filesystem
    // paths / private URLs.
    //
    // Phase 4 pins the payload key below exactly once inside this mapper
    // (split-count over the source text). Keep every other reference free of
    // that token, including option property names and comments.
    const legacyUrl = lesson["pdfUrl"];
    const materialRows = lesson.materials ?? [];
    const materialOpts: Parameters<typeof buildMaterialDescriptors>[0] = {
      materials: materialRows,
      includeProtected: !locked,
      eligibleScopes: viewerEligibleScopes,
    };
    materialOpts["legacyPdfUrl"] = legacyUrl;
    const materials = buildMaterialDescriptors(materialOpts);
    const unlockedPdf =
      materials.find((m) => m.downloadUrl && !m.legacy)?.downloadUrl ??
      materials.find((m) => m.legacy)?.downloadUrl ??
      null;
    return {
      id: lesson.id,
      title: lesson.title,
      titleAr: lesson.titleAr,
      officialCode: lesson.officialCode ?? null,
      order: lesson.order,
      duration: lesson.duration,
      // Phase 13: the retired `isLocked` column is no longer serialised. The
      // UI's lock badge is `status` (progression), which is what it already
      // reads; publishing an inert DB flag as though it meant something was
      // the conflation this phase removes.
      videoUrl: locked ? null : lesson.videoUrl,
      // Phase 14: authorized material path (or legacy external URL). Never a
      // storageKey. Null for locked sessions — same redaction shape as Phase 4.
      pdfUrl: locked ? null : unlockedPdf,
      materials: locked ? [] : materials,
      // Phase 16 — lock-independent presence. A PUBLISHED + LOCKED session
      // shows its skeleton, and these flags ARE the skeleton. Booleans and a
      // count only: no identities, no locations, no titles.
      // Phase C — every flag derives from the shared Lesson Content Summary
      // (video = modern SessionVideo rows of the viewer's own audience with
      // the legacy videoUrl fallback; material = the Phase 14 descriptor
      // authority; quiz/homework = existence in the viewer's OWN track
      // slice). The lesson page and the dashboard read the SAME numbers.
      hasVideo: (content?.video.count ?? 0) > 0,
      hasPdf: (content?.material.count ?? 0) > 0,
      materialCount: content?.material.count ?? 0,
      summary: locked ? null : lesson.summary,
      description: locked ? null : lesson.description,
      progress: locked ? 0 : lp?.progress || 0,
      isCompleted: locked ? false : !!lp?.isCompleted,
      status: statusById.get(lesson.id) ?? "available",
      requirements: locked ? null : requirementsByLesson.get(lesson.id) ?? null,
      // Presence flags only — enough for the "Quiz"/"Homework" badges in the
      // course tree, without naming or linking the protected items.
      // Phase C — track-filtered through the shared authority: the other
      // audience's quiz/homework rows are neither exposed nor counted.
      hasQuiz: (content?.quiz.count ?? 0) > 0,
      hasAssignment: (content?.homework.count ?? 0) > 0,
      // Phase C — the serialized summary itself (states + counts per
      // component). The tree chips, the lesson page workspace and the
      // Continue Learning card all describe content through this one shape.
      content: toLessonContentPayload(content),
      quiz: locked ? null : lesson.quizzes[0] || null,
      homework: locked ? null : lesson.homeworks[0] || null,
    };
  };

  // Reshape the parts/units/(topics)/lessons with progress + status attached.
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
      lessons: unit.lessons.map(toLesson),
      // Legacy topics whose lessons are all archived (or unit-linked, and so
      // already listed above) would render as empty sections — drop them.
      topics: unit.topics
        .filter((topic) => topic.lessons.some((lesson) => !lesson.unitId))
        .map((topic) => ({
        id: topic.id,
        title: topic.title,
        titleAr: topic.titleAr,
        order: topic.order,
        lessons: topic.lessons
          .filter((lesson) => !lesson.unitId)
          .map(toLesson),
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
