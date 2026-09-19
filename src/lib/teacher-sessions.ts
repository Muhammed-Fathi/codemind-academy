// CodeMind Academy — Teacher Session Workspace service (Phase E).
//
// THE ONE PLACE that answers, for the Phase E teacher workspace:
//
//   "Which academic Sessions may this teacher SEE and WORK on, and what is
//    the authoritative state of each Session's content?"
//
// The academic Session is the Lesson (Course → Part → Unit → Lesson). Phase E
// adds NOTHING to the curriculum model and NOTHING to readiness: lifecycle and
// readiness keep their single authorities (`src/lib/session-lifecycle.ts` /
// `computeLessonReadiness` / `getLessonReadiness`), materials keep their
// single storage architecture (`src/lib/session-materials.ts`), and the
// teacher scope keeps its single resolution
// (`Group.teacherId → Group.courseId`, never a request parameter).
//
// WHAT THIS MODULE OWNS
// =====================
//   1. The scoped session LIST with the four content indicators (VIDEO /
//      PDF / QUIZ / HOMEWORK) taken from the SAME `computeLessonReadiness`
//      the admin ceremony runs — never a second readiness implementation.
//   2. The scoped session WORKSPACE aggregate: overview + READ-ONLY video
//      status + materials (with the Phase E own/foreign management flag) +
//      quizzes + homework + the full Phase D readiness snapshot.
//   3. Teacher-safe MATERIAL writes: upload + deactivate. The rules are
//      deliberately stricter than the admin's ("manage-own"):
//        * the lesson must be owned (teacher → Group → Course) — 403/404
//          semantics identical to `loadOwnedLesson`;
//        * NO new content on an ARCHIVED lesson (the Phase 18 rule);
//        * the track scope must be contained by the LESSON's scope — the
//          teacher rule (stricter than the admin route, which trusts the
//          admin; a misplaced teacher scope would silently starve the
//          lesson's audience of a documented PDF);
//        * an ACTIVE material of the same (lesson × trackScope) that the
//          teacher does NOT own (foreign `MediaAsset.createdById`, typically
//          an admin upload, or any row whose creator cannot be proven) is
//          NEVER silently replaced — the upload REFUSES with FOREIGN_ACTIVE;
//        * deactivation is own-rows-only for the same reason.
//      Bytes/permissions still come from Phase 14: `validatePdfUpload`,
//      `makeStorageKey`, `writePrivateFile`, `assertVolumeQuota`,
//      `cleanupUnreferencedMediaAsset`. No new storage system, no
//      `Lesson.pdfUrl` writes, no storage keys in any payload.
//
// WHAT THIS MODULE NEVER DOES
// ===========================
//   * It never mutates `Lesson.status` (lifecycle is the ADMIN ceremony's —
//     Mark Ready / Open / Unpublish / Override live there, unchanged).
//   * It never touches SessionVideo (read-only counts/status derived from
//     the SAME readiness inputs; no video ids or media ids cross the wire).
//   * It never trusts a body/query-supplied teacherId, courseId or groupId.
//   * It never re-implements readiness, content visibility or track rules.

import { db } from "@/lib/db";
import {
  activeMediaStorageValue,
  makeStorageKey,
  writePrivateFile,
  validatePdfUpload,
  MAX_PDF_BYTES,
} from "@/lib/media";
import { assertVolumeQuota } from "@/lib/storage-quotas";
import {
  buildMaterialDescriptors,
  cleanupUnreferencedMediaAsset,
  isUsableLegacyPdfUrl,
  parseMaterialTrackScopeInput,
} from "@/lib/session-materials";
import {
  computeLessonReadiness,
  getLessonReadiness,
  audienceTracksForScope,
  READINESS_RESOURCES,
  type ReadinessItem,
  type ReadinessResourceKey,
  type LessonReadiness,
  type LessonReadinessSnapshot,
} from "@/lib/session-lifecycle";
import {
  normalizeTrackScope,
  resolveContentTrackScope,
  type TrackScope,
} from "@/lib/track-scope";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";
import {
  LESSON_PLACEMENT_SELECT,
  lessonPlacement,
  lessonTrackScope,
  loadOwnedLesson,
  isArchivedLesson,
  teacherCourseIds,
  localizedTitle,
  type ChainLesson,
} from "@/lib/teacher-content";
import { lessonCoursesChainOr } from "@/lib/session-progress";

export { TEACHER_LIMITS } from "@/lib/teacher-content";

// ---------------------------------------------------------------------------
// Session list — one row per in-scope lesson, readiness-derived indicators
// ---------------------------------------------------------------------------

/** One content indicator, taken VERBATIM from a readiness item. */
export type SessionIndicator = {
  /** OK | INVALID | MISSING — the Phase D state, never re-derived here. */
  state: ReadinessItem["state"];
  code: ReadinessItem["code"];
  /** Phase D's own audience count (e.g. published videos for the audience). */
  count: number;
};

export type TeacherSessionListItem = {
  id: string;
  title: string;
  titleRaw: string;
  titleAr: string | null;
  order: number;
  officialCode: string | null;
  trackScope: TrackScope;
  status: string;
  curriculumStatus: string;
  archived: boolean;
  chain: "CANONICAL" | "LEGACY";
  course: { id: string; name: string };
  part: { id: string; title: string; order: number };
  unit: { id: string; title: string; order: number };
  /** READY here means "satisfies every Phase D requirement" (canBeReady). */
  canBeReady: boolean;
  blocking: string[];
  indicators: Record<ReadinessResourceKey, SessionIndicator>;
};

function indicatorsOf(readiness: LessonReadiness): Record<ReadinessResourceKey, SessionIndicator> {
  const out = {} as Record<ReadinessResourceKey, SessionIndicator>;
  for (const key of READINESS_RESOURCES) {
    const item = readiness.items.find((i) => i.key === key);
    out[key] = {
      state: item?.state ?? "MISSING",
      code: item?.code ?? `${key}_MISSING`,
      count: item?.count ?? 0,
    };
  }
  return out;
}

/** The select the list needs: lifecycle + placement + every readiness input. */
const TEACHER_SESSION_LIST_SELECT = {
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
  videoUrl: true,
  pdfUrl: true,
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
          courseId: true,
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
              courseId: true,
              course: { select: { id: true, name: true, nameAr: true } },
            },
          },
        },
      },
    },
  },
  quizzes: {
    select: {
      id: true,
      trackScope: true,
      _count: { select: { questions: true } },
    },
  },
  homeworks: { select: { id: true, trackScope: true, instructions: true } },
  sessionVideos: {
    select: {
      id: true,
      isPublished: true,
      requiredPercent: true,
      batch: { select: { schoolType: true } },
    },
  },
  materials: {
    where: { isActive: true },
    select: { id: true, kind: true, mediaAssetId: true, trackScope: true },
  },
} as const;

/**
 * The teacher's session list. Scope is resolved from the teacher's own
 * `Group.courseId` rows. `filterCourseId` may only NARROW within that set —
// a course id the teacher does not own yields an EMPTY list (fail closed),
 * never an authorization leak.
 */
export async function listTeacherSessions(input: {
  teacher: { groups: Array<{ courseId: string }> };
  filterCourseId?: string | null;
}): Promise<TeacherSessionListItem[]> {
  const owned = teacherCourseIds(input.teacher);
  const requested = (input.filterCourseId ?? "").trim();
  const courseIds = requested
    ? owned.filter((id) => id === requested)
    : owned;
  if (courseIds.length === 0) return [];

  const lessons = await db.lesson.findMany({
    where: { OR: lessonCoursesChainOr(courseIds) },
    orderBy: [{ order: "asc" }, { id: "asc" }],
    select: TEACHER_SESSION_LIST_SELECT,
  });

  const rows: TeacherSessionListItem[] = [];
  for (const lesson of lessons) {
    const placement = lessonPlacement(lesson as unknown as ChainLesson);
    if (!placement) continue;
    const canonical = !!lesson.unit;
    // Phase D — the SAME computation the admin OPEN ceremony runs. There is
    // deliberately no cheaper/heavier variant for teachers: the indicator a
    // teacher sees in a list IS the readiness verdict.
    const readiness = computeLessonReadiness(lesson as never);
    rows.push({
      id: lesson.id,
      title: localizedTitle(lesson),
      titleRaw: lesson.title,
      titleAr: lesson.titleAr,
      order: lesson.order,
      officialCode: lesson.officialCode,
      trackScope: normalizeTrackScope(lesson.trackScope) ?? "SHARED",
      status: String(lesson.status),
      curriculumStatus: String(lesson.curriculumStatus),
      archived: String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED",
      chain: canonical ? "CANONICAL" : "LEGACY",
      course: { id: placement.courseId, name: placement.courseNameAr || placement.courseName },
      part: {
        id: placement.partId,
        title: placement.partTitleAr || placement.partTitle,
        order: lesson.unit?.part?.order ?? lesson.topic?.unit.part?.order ?? 0,
      },
      unit: {
        id: placement.unitId,
        title: placement.unitTitleAr || placement.unitTitle,
        order: lesson.unit?.order ?? lesson.topic?.unit?.order ?? 0,
      },
      canBeReady: readiness.canBeReady,
      blocking: readiness.blocking,
      indicators: indicatorsOf(readiness),
    });
  }

  return rows.sort(
    (a, b) =>
      a.course.id.localeCompare(b.course.id) ||
      a.part.order - b.part.order ||
      a.unit.order - b.unit.order ||
      a.order - b.order ||
      a.id.localeCompare(b.id)
  );
}

// ---------------------------------------------------------------------------
// Session workspace aggregate — overview + video + materials + quiz +
// homework + readiness, for ONE owned lesson
// ---------------------------------------------------------------------------

/** Read-only video status, counts only — no video ids, no media ids. */
export type TeacherVideoStatus = {
  /** The Phase D verdict for VIDEO (OK / INVALID / MISSING + code). */
  indicator: SessionIndicator;
  /** Published SessionVideo rows attached to this lesson for the audience. */
  publishedCount: number;
  /** Unpublished rows staged by the admin (informational, never editable). */
  unpublishedCount: number;
  /** Per-audience-track coverage (ARABIC/LANGUAGE for SHARED lessons). */
  audience: Array<{ track: SchoolType; published: boolean; unpublished: boolean }>;
};

export type TeacherMaterialRow = {
  id: string;
  title: string;
  kind: string;
  trackScope: TrackScope;
  isActive: boolean;
  /**
   * Phase E management flag: TRUE only when the material's MediaAsset proves
   * the CURRENT teacher uploaded it (MediaAsset.createdById === userId).
   * Admin-uploaded, generated or unproven rows surface as view-only.
   */
  own: boolean;
  /** Server-authorized download path (teacher is staff for Phase 14 review). */
  downloadUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  originalName: string | null;
  createdAt: Date | string;
};

export type TeacherSessionWorkspace = {
  lesson: TeacherSessionListItem & {
    /** Legacy read-only mirrors reported for context, never edited here. */
    legacyPdfUrl: string | null;
  };
  video: TeacherVideoStatus;
  materials: TeacherMaterialRow[];
  /** Safe active descriptors (student-shaped) for "what students would see". */
  activeMaterialDescriptors: ReturnType<typeof buildMaterialDescriptors>;
  quizzes: Array<{
    id: string;
    title: string;
    titleRaw: string;
    titleAr: string | null;
    description: string | null;
    passMark: number;
    timeLimit: number | null;
    trackScope: TrackScope;
    order: number;
    questionCount: number;
    attemptsCount: number;
  }>;
  homework: Array<{
    id: string;
    lessonId: string;
    title: string;
    titleRaw: string;
    titleAr: string | null;
    instructions: string | null;
    deadline: Date | string;
    maxMarks: number;
    trackScope: TrackScope;
    createdAt: Date | string;
    submissionsCount: number;
    gradedCount: number;
    status: string;
    publishedAt: Date | string | null;
    attachment: { id: string; originalName: string | null; mimeType: string | null; sizeBytes: number | null } | null;
  }>;
  /** The full Phase D snapshot — the same payload the admin route serves. */
  readiness: LessonReadiness;
};

export type TeacherSessionWorkspaceResult =
  | { ok: true; workspace: TeacherSessionWorkspace }
  | { ok: false; status: 404 | 403 };

/**
 * Load the complete workspace for ONE lesson the teacher owns, or a
 * 404/403 refusal with exactly `loadOwnedLesson` semantics.
 */
export async function loadTeacherSessionWorkspace(params: {
  lessonId: string;
  userId: string;
  courseIds: readonly string[];
}): Promise<TeacherSessionWorkspaceResult> {
  const owned = await loadOwnedLesson(params.lessonId, params.courseIds);
  if (!owned.ok) return { ok: false, status: owned.status };

  const lesson = owned.lesson;
  const placement = owned.placement;
  // Lesson.trackScope has a DB default (SHARED); a null here means broken
  // data — readiness would have failed closed upstream (getLessonReadiness
  // returns null in that case). The fallback exists for typing only.
  const lessonScope = lessonTrackScope(lesson) ?? "SHARED";

  // The readiness snapshot comes from the SAME loader the admin route uses —
  // never from a lighter teacher-only variant (Phase D's "one computation").
  const readiness = await getLessonReadiness(params.lessonId);
  if (!readiness) return { ok: false, status: 404 };

  // One detail query for everything the workspace aggregates beyond the
  // lifecycle columns: materials (with ownership proof), quizzes, homework,
  // and the video coverage flags the READ-ONLY panel renders from.
  const [materials, quizzes, homeworks, sessionVideosRow] = await Promise.all([
    db.material.findMany({
      where: { lessonId: params.lessonId },
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        kind: true,
        trackScope: true,
        isActive: true,
        createdAt: true,
        mediaAssetId: true,
        media: {
          select: {
            mimeType: true,
            sizeBytes: true,
            originalName: true,
            createdById: true,
          },
        },
      },
    }),
    db.quiz.findMany({
      where: { lessonId: params.lessonId },
      orderBy: [{ order: "asc" }, { title: "asc" }, { id: "asc" }],
      select: {
        id: true,
        title: true,
        titleAr: true,
        description: true,
        passMark: true,
        timeLimit: true,
        trackScope: true,
        order: true,
        // NOTE: Quiz has no createdAt column (schema L481) — do not add one.
        _count: { select: { questions: true, attempts: true } },
      },
    }),
    db.homework.findMany({
      where: { lessonId: params.lessonId },
      orderBy: [{ deadline: "asc" }, { id: "asc" }],
      select: {
        id: true,
        lessonId: true,
        title: true,
        titleAr: true,
        instructions: true,
        deadline: true,
        maxMarks: true,
        trackScope: true,
        createdAt: true,
        status: true,
        publishedAt: true,
        attachment: { select: { id: true, originalName: true, mimeType: true, sizeBytes: true } },
        submissions: { select: { status: true } },
      },
    }),
    db.sessionVideo.findMany({
      where: { lessonId: params.lessonId },
      select: {
        isPublished: true,
        batch: { select: { schoolType: true } },
      },
    }),
  ]);

  // Video — READ-ONLY. Derived from the same rows readiness consumed (same
  // include), and reported as counts + per-track flags only. No identifiers.
  const audience = audienceTracksForScope(lessonScope);
  const trackFlags = audience.map((track) => {
    const rows = sessionVideosRow.filter(
      (v) => normalizeSchoolType(v.batch?.schoolType) === track
    );
    return {
      track,
      published: rows.some((v) => v.isPublished === true),
      unpublished: rows.some((v) => v.isPublished !== true),
    };
  });
  const videoItem = readiness.items.find((i) => i.key === "VIDEO");
  const publishedVideos = sessionVideosRow.filter((v) => v.isPublished === true);
  const unpublishedVideos = sessionVideosRow.filter((v) => v.isPublished !== true);

  // Materials — the management view lists ALL rows; the management flag
  // (`own`) is the Phase E manage-own rule over `MediaAsset.createdById`.
  const materialRows: TeacherMaterialRow[] = materials.map((m) => ({
    id: m.id,
    title: m.title,
    kind: String(m.kind),
    trackScope: normalizeTrackScope(m.trackScope) ?? "SHARED",
    isActive: m.isActive,
    own: !!m.media?.createdById && m.media.createdById === params.userId,
    downloadUrl: m.isActive && m.mediaAssetId ? `/api/materials/${m.id}` : null,
    mimeType: m.media?.mimeType ?? null,
    sizeBytes: m.media?.sizeBytes ?? null,
    originalName: m.media?.originalName ?? null,
    createdAt: m.createdAt,
  }));

  const legacyPdf = await db.lesson.findUnique({
    where: { id: params.lessonId },
    select: { pdfUrl: true },
  });

  const activeDescriptors = buildMaterialDescriptors({
    materials: materials.filter((m) => m.isActive),
    legacyPdfUrl: legacyPdf?.pdfUrl ?? null,
    includeProtected: true,
  });

  const listItem = (await listTeacherSessionsLight(params.lessonId, lesson, placement, readiness))!;

  return {
    ok: true,
    workspace: {
      lesson: {
        ...listItem,
        legacyPdfUrl: isUsableLegacyPdfUrl(legacyPdf?.pdfUrl)
          ? legacyPdf!.pdfUrl!.slice(0, 500)
          : null,
      },
      video: {
        indicator: {
          state: videoItem?.state ?? "MISSING",
          code: videoItem?.code ?? "VIDEO_MISSING",
          count: videoItem?.count ?? 0,
        },
        publishedCount: publishedVideos.length,
        unpublishedCount: unpublishedVideos.length,
        audience: trackFlags,
      },
      materials: materialRows,
      activeMaterialDescriptors: activeDescriptors,
      quizzes: quizzes.map((q) => ({
        id: q.id,
        title: localizedTitle(q),
        titleRaw: q.title,
        titleAr: q.titleAr,
        description: q.description,
        passMark: q.passMark,
        timeLimit: q.timeLimit,
        trackScope: normalizeTrackScope(q.trackScope) ?? "SHARED",
        order: q.order,
        questionCount: q._count.questions,
        attemptsCount: q._count.attempts,
      })),
      homework: homeworks.map((h) => ({
        id: h.id,
        lessonId: h.lessonId,
        title: localizedTitle(h),
        titleRaw: h.title,
        titleAr: h.titleAr,
        instructions: h.instructions,
        deadline: h.deadline,
        maxMarks: h.maxMarks,
        trackScope: normalizeTrackScope(h.trackScope) ?? "SHARED",
        createdAt: h.createdAt,
        submissionsCount: h.submissions.length,
        gradedCount: h.submissions.filter((s) => s.status === "GRADED").length,
        status: h.status,
        publishedAt: h.publishedAt,
        attachment: h.attachment,
      })),
      readiness,
    },
  };
}

/** Build the list-row shape for the workspace's own overview header. */
async function listTeacherSessionsLight(
  lessonId: string,
  lesson: ChainLesson,
  placement: ReturnType<typeof lessonPlacement>,
  readiness: LessonReadinessSnapshot
): Promise<TeacherSessionListItem | null> {
  if (!placement) return null;
  const orderRows = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      order: true,
      title: true,
      titleAr: true,
      unit: { select: { order: true, part: { select: { order: true } } } },
      topic: { select: { unit: { select: { order: true, part: { select: { order: true } } } } } },
    },
  });
  const titleRaw = orderRows?.title ?? lesson.officialCode ?? "Session";
  const titleAr = orderRows?.titleAr ?? null;
  return {
    id: lesson.id,
    title: localizedTitle({ title: titleRaw, titleAr }),
    titleRaw,
    titleAr,
    order: orderRows?.order ?? 0,
    officialCode: lesson.officialCode,
    // Same typing-only fallback as the workspace loader (DB default SHARED).
    trackScope: lessonTrackScope(lesson) ?? "SHARED",
    status: String(lesson.status),
    curriculumStatus: String(lesson.curriculumStatus),
    archived: String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED",
    chain: placement.chain,
    course: { id: placement.courseId, name: placement.courseNameAr || placement.courseName },
    part: {
      id: placement.partId,
      title: placement.partTitleAr || placement.partTitle,
      order:
        orderRows?.unit?.part?.order ?? orderRows?.topic?.unit.part?.order ?? 0,
    },
    unit: {
      id: placement.unitId,
      title: placement.unitTitleAr || placement.unitTitle,
      order: orderRows?.unit?.order ?? orderRows?.topic?.unit?.order ?? 0,
    },
    canBeReady: readiness.canBeReady,
    blocking: readiness.blocking,
    indicators: indicatorsOf(readiness),
  };
}

// ---------------------------------------------------------------------------
// Teacher-safe MATERIAL writes (manage-own; Phase 14 storage internals),
// ---------------------------------------------------------------------------

export type TeacherMaterialFailure =
  | { ok: false; code: "LESSON_NOT_FOUND"; status: 404; message: string }
  | { ok: false; code: "NOT_OWNED"; status: 403; message: string }
  | { ok: false; code: "LESSON_ARCHIVED"; status: 409; message: string }
  | { ok: false; code: "INVALID_TRACK_SCOPE"; status: 400; message: string }
  | { ok: false; code: "OUT_OF_LESSON_SCOPE"; status: 400; message: string }
  | {
      ok: false;
      code: "FOREIGN_ACTIVE";
      status: 409;
      message: string;
      /** The conflicting active row (id + title only) for the message. */
      conflict: { id: string; title: string; trackScope: TrackScope };
    }
  | { ok: false; code: "VALIDATION_FAILED"; status: 400 | 413 | 415; message: string; validation?: unknown }
  | { ok: false; code: "QUOTA_EXCEEDED"; status: 413; message: string };

export type TeacherMaterialUploadSuccess = {
  ok: true;
  material: {
    id: string;
    lessonId: string;
    title: string;
    kind: "ADMIN_UPLOADED";
    trackScope: TrackScope;
    isActive: true;
    downloadUrl: string;
    mimeType: string;
    sizeBytes: number;
    originalName: string;
  };
  replaced: { materialId: string }[];
  cleanedUpAssets: string[];
};

/**
 * Upload (buffered) a session PDF for a lesson the teacher OWNS.
 *
 * Manage-own semantics, decided up front (before any byte is written):
 *
 *   * Foreign active material of the same (lesson × trackScope) → REFUSE
 *     (409 FOREIGN_ACTIVE). A teacher upload must never silently deactivate
 *     the admin's PDF to take its place; the conflict is reported so the UI
 *     can say exactly why, and only the admin can replace their own row.
 *   * The teacher's OWN prior active rows of the same scope are replaced
 *     (deactivated) — the Phase 14 "one active PDF per lesson × scope" rule,
 *     restricted to rows this actor created.
 *
 * The transaction deactivates own actives + creates MediaAsset
 * (createdById = teacher's userId) + Material in one commit, then the
 * reference-counted asset cleanup runs after commit, exactly like the Phase
 * 14 finalize path.
 */
export async function teacherUploadLessonPdfMaterial(params: {
  lessonId: string;
  userId: string;
  courseIds: readonly string[];
  buffer: Buffer | Uint8Array;
  claimedMime?: string | null;
  originalName?: string | null;
  title?: string | null;
  trackScope?: unknown;
  maxBytes?: number;
}): Promise<TeacherMaterialFailure | TeacherMaterialUploadSuccess> {
  const owned = await loadOwnedLesson(params.lessonId, params.courseIds);
  if (!owned.ok) {
    return owned.status === 403
      ? { ok: false, code: "NOT_OWNED", status: 403, message: "This lesson is not from your courses" }
      : { ok: false, code: "LESSON_NOT_FOUND", status: 404, message: "Lesson not found" };
  }
  if (isArchivedLesson(owned.lesson)) {
    return {
      ok: false,
      code: "LESSON_ARCHIVED",
      status: 409,
      message: "Cannot attach materials to an archived lesson",
    };
  }

  // Track scope — the TEACHER rule (containment in the lesson scope). A
  // shared lesson may take a track-specific PDF; a track lesson must never
  // receive a PDF of the OTHER track or be widened to SHARED by omission.
  const scopeDecision = resolveContentTrackScope(
    params.trackScope,
    lessonTrackScope(owned.lesson)
  );
  if (!scopeDecision.ok) {
    // parseMaterialTrackScopeInput-parity: distinguish "not a scope" from
    // "a scope this lesson cannot host".
    const parsed = parseMaterialTrackScopeInput(params.trackScope);
    return parsed.ok === false
      ? { ok: false, code: "INVALID_TRACK_SCOPE", status: 400, message: "trackScope must be SHARED, ARABIC, or LANGUAGE" }
      : { ok: false, code: "OUT_OF_LESSON_SCOPE", status: 400, message: "The material track is outside this lesson's track scope" };
  }
  const trackScope = scopeDecision.scope;

  // Manage-own gate: an ACTIVE row of this (lesson × scope) that this teacher
  // did not upload blocks the upload — including rows with NO creator proof
  // (fail closed: unproven = foreign).
  const actives = await db.material.findMany({
    where: { lessonId: params.lessonId, trackScope, isActive: true },
    select: {
      id: true,
      title: true,
      trackScope: true,
      media: { select: { createdById: true } },
    },
  });
  const foreign = actives.filter((m) => !m.media?.createdById || m.media.createdById !== params.userId);
  if (foreign.length > 0) {
    const first = foreign[0]!;
    return {
      ok: false,
      code: "FOREIGN_ACTIVE",
      status: 409,
      message: "An active material for this track is managed by the admin and cannot be replaced by a teacher upload",
      conflict: {
        id: first.id,
        title: first.title,
        trackScope: normalizeTrackScope(first.trackScope) ?? "SHARED",
      },
    };
  }

  const validation = validatePdfUpload({
    buffer: params.buffer,
    claimedMime: params.claimedMime,
    originalName: params.originalName,
    maxBytes: params.maxBytes ?? MAX_PDF_BYTES,
  });
  if (!validation.ok) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      status:
        validation.code === "TOO_LARGE"
          ? 413
          : validation.code === "MIME_REJECTED" || validation.code === "MAGIC_REJECTED"
            ? 415
            : 400,
      message: validation.message,
      validation,
    };
  }

  const buffer = Buffer.isBuffer(params.buffer) ? params.buffer : Buffer.from(params.buffer);
  // Bytes first, rows second — the Phase 14 ordering. The backend value is
  // resolved BEFORE any write so an unsupported environment fails untouched.
  const storage = activeMediaStorageValue();
  const quota = await assertVolumeQuota(buffer.length);
  if (!quota.ok) {
    return { ok: false, code: "QUOTA_EXCEEDED", status: 413, message: "Media storage quota exceeded" };
  }
  const storageKey = makeStorageKey("session-pdfs", "pdf");
  await writePrivateFile(storageKey, buffer, {
    mimeType: validation.mimeType,
    originalName: validation.originalName,
  });

  const title =
    (typeof params.title === "string" && params.title.trim()) ||
    validation.originalName ||
    "material.pdf";
  const priorAssetIds = actives
    .filter((m) => m.media?.createdById === params.userId)
    .map((m) => m.id);

  const created = await db.$transaction(async (tx) => {
    // Replace = deactivate the teacher's OWN prior actives of this scope.
    if (priorAssetIds.length) {
      await tx.material.updateMany({
        where: { id: { in: priorAssetIds } },
        data: { isActive: false },
      });
    }
    const asset = await tx.mediaAsset.create({
      data: {
        kind: "DOCUMENT",
        storage,
        storageKey,
        mimeType: validation.mimeType,
        sizeBytes: validation.sizeBytes,
        originalName: validation.originalName,
        isPrivate: true,
        createdById: params.userId,
      },
    });
    const material = await tx.material.create({
      data: {
        lessonId: params.lessonId,
        kind: "ADMIN_UPLOADED",
        title,
        trackScope,
        isActive: true,
        mediaAssetId: asset.id,
      },
    });
    return { material, asset };
  });

  // Reference-counted cleanup AFTER commit, Phase 14 semantics: bytes of the
  // replaced rows go away only when nothing else still references them.
  const priorRows = await db.material.findMany({
    where: { id: { in: priorAssetIds } },
    select: { mediaAssetId: true },
  });
  const cleanedUpAssets: string[] = [];
  for (const row of priorRows) {
    if (!row.mediaAssetId) continue;
    const removed = await cleanupUnreferencedMediaAsset(row.mediaAssetId);
    if (removed) cleanedUpAssets.push(row.mediaAssetId);
  }

  // Best-effort audit — identical action family to the admin route, with the
  // actor role recorded so an operator can tell who staged the file.
  await db.auditLog
    .create({
      data: {
        userId: params.userId,
        action: "LESSON_MATERIAL_UPLOAD",
        entity: "Material",
        entityId: created.material.id,
        details: JSON.stringify({
          actorRole: "TEACHER",
          lessonId: params.lessonId,
          materialId: created.material.id,
          mediaAssetId: created.asset.id,
          trackScope,
          sizeBytes: validation.sizeBytes,
          replaced: priorAssetIds,
          cleanedUpAssets,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return {
    ok: true,
    material: {
      id: created.material.id,
      lessonId: created.material.lessonId,
      title: created.material.title,
      kind: "ADMIN_UPLOADED",
      trackScope: created.material.trackScope,
      isActive: true,
      downloadUrl: `/api/materials/${created.material.id}`,
      mimeType: validation.mimeType,
      sizeBytes: validation.sizeBytes,
      originalName: validation.originalName,
    },
    replaced: priorAssetIds.map((materialId) => ({ materialId })),
    cleanedUpAssets,
  };
}

export type TeacherMaterialDeactivateResult =
  | { ok: true; cleanedUpAsset: string | null }
  | {
      ok: false;
      code: "MATERIAL_NOT_FOUND" | "NOT_OWNED_LESSON" | "NOT_OWNED_MATERIAL" | "LESSON_NOT_FOUND";
      status: 403 | 404;
      message: string;
    };

/**
 * Deactivate a material — ONLY when the material hangs off a lesson the
 * teacher owns AND its MediaAsset proves the teacher uploaded it.
 * Admin-uploaded / unproven rows answer 403 NOT_OWNED_MATERIAL (the row's
 * existence is not a secret from staff who can already list the lesson).
 */
export async function teacherDeactivateLessonMaterial(params: {
  materialId: string;
  userId: string;
  courseIds: readonly string[];
}): Promise<TeacherMaterialDeactivateResult> {
  const material = await db.material.findUnique({
    where: { id: params.materialId },
    select: {
      id: true,
      lessonId: true,
      isActive: true,
      mediaAssetId: true,
      media: { select: { createdById: true } },
      lesson: { select: LESSON_PLACEMENT_SELECT },
    },
  });
  if (!material) {
    return { ok: false, code: "MATERIAL_NOT_FOUND", status: 404, message: "Material not found" };
  }
  const placement = lessonPlacement(material.lesson as ChainLesson | null);
  if (!placement) {
    return { ok: false, code: "LESSON_NOT_FOUND", status: 404, message: "Lesson not found" };
  }
  if (!params.courseIds.includes(placement.courseId)) {
    return { ok: false, code: "NOT_OWNED_LESSON", status: 403, message: "This lesson is not from your courses" };
  }
  // Manage-own: no creator proof OR another actor's id → never touchable.
  if (!material.media?.createdById || material.media.createdById !== params.userId) {
    return { ok: false, code: "NOT_OWNED_MATERIAL", status: 403, message: "Only materials you uploaded can be removed" };
  }

  if (material.isActive) {
    await db.material.update({
      where: { id: material.id },
      data: { isActive: false },
    });
  }

  let cleanedUpAsset: string | null = null;
  if (material.mediaAssetId) {
    const removed = await cleanupUnreferencedMediaAsset(material.mediaAssetId);
    if (removed) cleanedUpAsset = material.mediaAssetId;
  }

  await db.auditLog
    .create({
      data: {
        userId: params.userId,
        action: "LESSON_MATERIAL_DEACTIVATE",
        entity: "Material",
        entityId: material.id,
        details: JSON.stringify({
          actorRole: "TEACHER",
          lessonId: material.lessonId,
          materialId: material.id,
          mediaAssetId: material.mediaAssetId,
          cleanedUpAsset,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return { ok: true, cleanedUpAsset };
}
