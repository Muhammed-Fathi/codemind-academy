// CodeMind Academy — Session lifecycle & publishing core (Phase 13).
//
// THE CONTRACT
// ============
// A lesson has TWO independent dimensions, and conflating them is the defect
// this module exists to remove:
//
//   Administrative lifecycle (STORED here, on Lesson.status)
//     DRAFT     → being prepared. Admin-visible only.
//     READY     → prepared and passing the readiness contract. Still
//                 admin-visible only: no student access by any path.
//     PUBLISHED → eligible for the student curriculum universe.
//
//   Student progression (DERIVED per student, NEVER stored)
//     LOCKED / UNLOCKED / COMPLETED → `src/lib/session-progress.ts`.
//
// So `PUBLISHED + LOCKED` is a normal state (in the curriculum, prerequisites
// not yet met) and `PUBLISHED != unlocked != completed`. The reverse
// combination — `DRAFT`/`READY` + student-visible — is the one the platform
// must never produce, which is why every student reader filters on
// `status = PUBLISHED` through the single constant exported below.
//
// THE RULES THIS MODULE OWNS
// ==========================
//  1. `status` is the ONLY lifecycle source of truth. `Lesson.isPublished` is
//     a deprecated compatibility MIRROR that this module keeps in sync (it is
//     the only writer) and that NO reader may derive behaviour from.
//     `Lesson.isLocked` stays retired and inert: never read, never written,
//     never revived. Student lock state is progression, i.e.
//     `unlocked = eligibility`.
//  2. Lifecycle transitions are a state machine, not a writable field:
//         DRAFT → READY        mark-ready  (validated)
//         READY → PUBLISHED    open        (validated, the ONLY publish path)
//         PUBLISHED → READY    unpublish   (explicit admin action)
//     Forbidden by construction: DRAFT → PUBLISHED (READY cannot be bypassed),
//     PUBLISHED → DRAFT, and ANY transition on an ARCHIVED lesson. There is no
//     generic `PATCH { status }` anywhere in the platform, on purpose.
//  3. Readiness is a PURE computation (`computeLessonReadiness`) over an
//     already-loaded lesson, so the admin ceremony, the readiness endpoint and
//     the tests all evaluate the exact same rules. No second implementation is
//     allowed — if you are tempted to re-check a resource inside a route, you
//     are creating the drift this rule exists to prevent.
//  4. Everything FAILS CLOSED. An unrecognised `status`, a lesson attached to
//     no course, an empty quiz, a video that is not published: each yields a
//     refusal with a machine-readable code, never a permissive default.
//  5. Publishing is IDEMPOTENT: a second OPEN returns the existing published
//     state, writes nothing and performs no second semantic publish.
//  6. Phase 13 publishes NOTHING to students' notification feeds. There is no
//     fan-out, no `NEW_LESSON` notification and no `notifiedAt` write in this
//     engine; `SessionPublication` is the state Phase 17 consumes. (Phase 17
//     has since landed — `session-notifications.ts` — and fans out from the
//     OPEN ROUTE after a successful ceremony; the engine itself remains
//     notification-free, and the Phase 17 columns on SessionPublication are
//     written by the fan-out, never here.)
//
// PHASE D — THE FOUR-REQUIREMENT READINESS CONTRACT + EMERGENCY OVERRIDE
// ========================================================================
// Phase D replaced the Phase 13 "video-only requirement" contract. A lesson
// is normally READY only when ALL FOUR academic components exist and are
// valid for the lesson's audience:
//
//   VIDEO     — a PUBLISHED SessionVideo linked to the lesson, covering the
//               lesson's audience batches (the modern Phase A/B authority).
//               Legacy `Lesson.videoUrl` is NO LONGER a readiness authority:
//               it is still surfaced to admins as a compatibility link, but
//               it never satisfies the requirement on its own.
//   PDF       — at least one valid lesson-linked Material (the Phase 14
//               architecture: active, document-like — ADMIN_UPLOADED or
//               carrying a MediaAsset), covering the lesson's audience.
//               Legacy `Lesson.pdfUrl` is likewise compatibility-only.
//   QUIZ      — at least one linked Quiz with questions, covering the
//               lesson's audience.
//   HOMEWORK  — at least one linked Homework with actionable instructions,
//               covering the lesson's audience.
//
// "Covering the lesson's audience" = the Phase 12 track rule extended to a
// coverage rule: an ARABIC/LANGUAGE lesson needs a resource scoped to its own
// track or SHARED; a SHARED lesson needs BOTH tracks covered (a SHARED
// resource covers both by itself). A requirement with missing coverage fails
// closed with a machine code (see `computeLessonReadiness`).
//
// EMERGENCY OVERRIDE (admin-only, audited): when readiness is incomplete an
// ADMIN may open the session anyway through `openLessonWithOverride`
// (`POST /api/admin/lessons/[id]/open-override`). The override NEVER happens
// silently: it requires a non-empty reason, re-validates everything else
// server-side (archived/orphan/concurrency rules still apply — the override
// bypasses READINESS ONLY, never permissions, lifecycle order or
// progression), stages DRAFT→READY inside the same atomic ceremony when
// needed, and writes a dedicated `LESSON_OPEN_OVERRIDE` audit row carrying
// the admin, the lesson, the timestamp, the missing requirements and the
// reason. Teachers, students and parents have no override of any kind.
//
// Track interaction (Phase 12): `trackScope` decides WHO a session is for,
// `status` decides WHETHER it exists for students at all. They are ANDed, never
// substituted for one another, and readiness evaluates a lesson against the
// resources that actually apply to ITS track (see `resourceAppliesToScope`).
//
// See docs/PHASE_13_SESSION_LIFECYCLE.md for the full contract.

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";
import {
  normalizeTrackScope,
  type TrackScope,
} from "@/lib/track-scope";

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type LessonStatus = "DRAFT" | "READY" | "PUBLISHED";

/** Declaration order IS lifecycle order (`lifecycleRank` relies on it). */
export const LESSON_STATUSES: readonly LessonStatus[] = [
  "DRAFT",
  "READY",
  "PUBLISHED",
] as const;

/**
 * The lifecycle state a brand-new lesson starts in, and the state every row
 * fails closed to. Exported so a future creation path (Phase 15's admin
 * lesson CRUD) cannot invent its own initial state or leave the
 * `isPublished` mirror unsynchronised.
 */
export const LESSON_NEW_LIFECYCLE = {
  status: "DRAFT",
  isPublished: false,
} as const;

/** The mirror value of `status` — the ONLY sanctioned way to touch it. */
export function publishedMirror(status: LessonStatus): boolean {
  return status === "PUBLISHED";
}

/**
 * Canonicalise any stored/incoming value. `null` means "this is not a
 * lifecycle state at all", and every caller below fails closed on it — an
 * unrecognised value is treated as DRAFT (invisible to students), never as
 * PUBLISHED and never as a permissive default.
 */
export function normalizeLessonStatus(value: unknown): LessonStatus | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  if (v === "DRAFT" || v === "READY" || v === "PUBLISHED") return v;
  // Legacy vocabulary of the pre-lifecycle platform, accepted ONLY as input
  // normalisation (never stored, never returned): the historical boolean was
  // exactly "visible or not", which maps onto the two ends of the chain.
  if (v === "TRUE" || v === "1" || v === "1.0") return "PUBLISHED";
  if (v === "FALSE" || v === "0" || v === "0.0") return "DRAFT";
  return null;
}

/**
 * Is a lesson in this status part of the STUDENT curriculum universe?
 *
 * Deliberately the ONLY place that answers the question, so no route can
 * quietly decide that `READY` is student-visible too.
 */
export function isStudentVisibleStatus(status: unknown): boolean {
  return normalizeLessonStatus(status) === "PUBLISHED";
}

/**
 * Prisma `where` fragment for the student curriculum universe. Spread into
 * EVERY lesson query a student (or a parent previewing for a child) can use.
 *
 * It composes with — never replaces — Phase 11's `EXCLUDE_ARCHIVED_LESSON`
 * and Phase 12's `trackScopeWhere`: a session is a student's only when it is
 * PUBLISHED, not archived, and on their track.
 */
export const LESSON_STUDENT_STATUS_FILTER = {
  status: "PUBLISHED",
} as const;

/** 0 < 1 < 2; an unrecognised status ranks as DRAFT (fail closed). */
export function lifecycleRank(status: unknown): number {
  const s = normalizeLessonStatus(status) ?? "DRAFT";
  return LESSON_STATUSES.indexOf(s);
}

/**
 * The transition table. Pure and total: every (from, to) pair is either listed
 * here or forbidden, and the rules are stated as data so a test can enumerate
 * the whole matrix rather than trust a comment.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<LessonStatus, readonly LessonStatus[]>
> = {
  DRAFT: ["READY"],
  READY: ["PUBLISHED", "DRAFT"],
  PUBLISHED: ["READY"],
} as const;

export function canTransition(from: unknown, to: unknown): boolean {
  const f = normalizeLessonStatus(from);
  const t = normalizeLessonStatus(to);
  if (!f || !t) return false; // unrecognised state → no transition at all
  return (ALLOWED_TRANSITIONS[f] as readonly LessonStatus[]).includes(t);
}

// ---------------------------------------------------------------------------
// Readiness contract
// ---------------------------------------------------------------------------
//
// THE CONTRACT, stated in full (every question the phase must not leave
// ambiguous is answered here, in the code that enforces it):
//
//   VIDEO      REQUIRED for READY. Phase D: satisfied ONLY by a PUBLISHED
//              `SessionVideo` linked to the lesson whose batch school type
//              covers the lesson's audience (the modern Phase A/B authority).
//              A SHARED lesson needs published videos in BOTH batches,
//              because a video published to one batch is invisible to the
//              other track — one-sided staging is NOT READY. An UNPUBLISHED
//              SessionVideo never counts: it is staged media, not prepared
//              media. Legacy `Lesson.videoUrl` is NOT a readiness authority
//              any more (it is reported as a note when present so admins see
//              why it no longer counts); it remains a read-only compatibility
//              link on the admin surfaces and the student player fallback.
//   PDF        REQUIRED for READY (Phase D). Satisfied by at least one valid
//              lesson-linked Material — the Phase 14 architecture: the row is
//              ACTIVE and document-like (`kind === "ADMIN_UPLOADED"` or it
//              carries a `mediaAssetId`) and its trackScope covers the
//              lesson's audience. Legacy `Lesson.pdfUrl` is NOT a readiness
//              authority: the seeded placeholder `"#"` was never content, and
//              a real legacy url is reported as a note, never as credit.
//              What qualifies, exactly: `Material(kind=ADMIN_UPLOADED,
//              isActive=true)` rows created by the Phase 14 upload flow
//              (each carries a MediaAsset); GENERATED rows without a media
//              asset are not documents and never count.
//   QUIZ       REQUIRED for READY (Phase D). A quiz applies when its own
//              trackScope applies to the considered audience track, and it is
//              VALID only when it has at least one question: zero questions
//              is INVALID (a session that shows a quiz badge and then
//              presents an empty attempt is a broken lesson), and an
//              unreadable question count fails closed the same way.
//   HOMEWORK   REQUIRED for READY (Phase D). Same coverage rule as QUIZ;
//              invalid when it carries no actionable instructions (an
//              assignment a student cannot act on).
//   trackScope A resource counts toward an audience track only if its own
//              scope is SHARED or exactly that track. Unrelated track content
//              never makes a lesson ready; it is reported as a `note`, never
//              silently — silently ignoring it is how a SHARED lesson ends up
//              published with ARABIC-only material.
//   requirements do NOT vary per track beyond coverage: there is no per-track
//              readiness state, and no hidden variant model.
//   ARCHIVED   blocks READY and blocks PUBLISHED. `LEGACY` and `OFFICIAL`
//              lessons follow the same readiness rules — the lifecycle is not
//              an official-curriculum-only privilege — but see the ceremony: an
//              archived lesson can never be opened at all.
//   missing REQUIRED resources block READY, and since publishing requires
//              READY + re-validated readiness, they block PUBLISHED through
//              the same single rule. The ONLY way around a blocked readiness
//              is the admin emergency override (`openLessonWithOverride`),
//              which is explicit, reason-bearing and audited.

export type ReadinessResourceKey = "VIDEO" | "PDF" | "QUIZ" | "HOMEWORK";

/** Stable, ordered — the checklist rendering order, and the comparison order. */
export const READINESS_RESOURCES: readonly ReadinessResourceKey[] = [
  "VIDEO",
  "PDF",
  "QUIZ",
  "HOMEWORK",
] as const;

export type ReadinessState =
  /** requirement satisfied */
  | "OK"
  /** required and absent */
  | "MISSING"
  /** present but broken (and therefore blocking) */
  | "INVALID"
  /** not required by the contract in this phase (informational only) */
  | "NOT_APPLICABLE";

export type ReadinessItem = {
  key: ReadinessResourceKey;
  /** Does the contract require this resource for THIS lesson? */
  required: boolean;
  /** Does any resource of this kind exist for this lesson's track? */
  present: boolean;
  /** Would a student be able to use it if they got in? */
  valid: boolean;
  state: ReadinessState;
  /** Stable machine code, e.g. `VIDEO_MISSING`. Never localised, never free text. */
  code: string;
  /** How many underlying rows satisfy/violate the item (deterministic detail). */
  count: number;
};

export type ReadinessLessonInput = {
  id?: string;
  status?: unknown;
  curriculumStatus?: unknown;
  trackScope?: unknown;
  officialCode?: string | null;
  videoUrl?: string | null;
  pdfUrl?: string | null;
  quizzes?: readonly {
    id?: string;
    trackScope?: unknown;
    questionCount?: number | null;
    questions?: readonly unknown[] | null;
  }[];
  homeworks?: readonly {
    id?: string;
    trackScope?: unknown;
    instructions?: string | null;
  }[];
  sessionVideos?: readonly {
    id?: string;
    isPublished?: boolean | null;
    requiredPercent?: number | null;
    batch?: { schoolType?: unknown } | null;
  }[];
  materials?: readonly {
    id?: string;
    kind?: string | null;
    isActive?: boolean | null;
    mediaAssetId?: string | null;
    /** Phase 14 — material track eligibility. */
    trackScope?: unknown;
  }[];
};

export type LessonReadiness = {
  lessonId: string | null;
  /** `1-1`…`7-3` for official sessions, `null` for legacy/created-by-hand. */
  officialCode: string | null;
  status: LessonStatus;
  /** `OFFICIAL` / `LEGACY` / `ARCHIVED`; `null` when the row carries none. */
  curriculumStatus: string | null;
  archived: boolean;
  trackScope: TrackScope;
  items: ReadinessItem[];
  /** Nothing required is missing/invalid, and the lesson is not archived. */
  canBeReady: boolean;
  /**
   * Publishable RIGHT NOW: `canBeReady`. Publishing requires the READY
   * checkpoint in addition (the ceremony, not the computation, enforces the
   * transition), and readiness is re-evaluated at OPEN, so a stale READY
   * never becomes a warrant.
   */
  canPublish: boolean;
  /** Stable, sorted blocking codes — the checklist's "why not". */
  blocking: string[];
  /** Present-but-not-applicable observations. Never blocking. */
  notes: string[];
};

const PLACEHOLDER_MARKERS = new Set(["", "#", "##", "./#", "null", "none", "-"]);

/** A legacy string url counts only when it is actually a url-ish value. */
function usableUrl(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return v.length > 0 && !PLACEHOLDER_MARKERS.has(v.toLowerCase());
}

function questionCountOf(q: {
  questionCount?: number | null;
  questions?: readonly unknown[] | null;
  _count?: { questions?: number | null } | null;
}): number | null {
  if (typeof q.questionCount === "number" && Number.isFinite(q.questionCount)) {
    return Math.max(0, Math.floor(q.questionCount));
  }
  // The `READINESS_LESSON_INCLUDE` shape: `{ _count: { questions: N } }`.
  // Checked before the `questions` array so the loader's own projection is
  // authoritative whenever it is present.
  const counted = q?._count?.questions;
  if (typeof counted === "number" && Number.isFinite(counted)) {
    return Math.max(0, Math.floor(counted));
  }
  if (Array.isArray(q.questions)) return q.questions.length;
  return null;
}

/**
 * Does a resource carrying `resourceScope` apply to a lesson carrying
 * `lessonScope`?
 *
 * SHARED applies everywhere; a track-specific resource applies only to its own
 * lesson track. It can never WIDEN a lesson (an ARABIC homework on a LANGUAGE
 * lesson is somebody else's content) and a SHARED lesson may legitimately host
 * both an ARABIC and a LANGUAGE variant — in which case each is evaluated on
 * its own terms, and the lesson is ready when the required dimensions are
 * covered for the lesson's own audience.
 */
export function resourceAppliesToScope(
  lessonScope: TrackScope,
  resourceScope: unknown
): boolean {
  const rs = normalizeTrackScope(resourceScope);
  if (!rs) return false; // unrecognised tag → not applicable (fail closed)
  if (rs === "SHARED") return true;
  return rs === lessonScope;
}

/**
 * Phase D — the audience tracks a lesson's readiness must COVER.
 *
 * A SHARED lesson teaches BOTH school types, so every requirement must be
 * covered for ARABIC and LANGUAGE students alike (a SHARED-scoped resource
 * covers both tracks by itself). A track-specific lesson has a one-track
 * audience. Pure and total: unrecognised scopes normalise to SHARED first.
 */
export function audienceTracksForScope(scope: TrackScope): readonly SchoolType[] {
  return scope === "SHARED" ? (["ARABIC", "LANGUAGE"] as const) : [scope];
}

/**
 * Phase D — audience COVERAGE evaluation shared by the PDF/QUIZ/HOMEWORK
 * dimensions (video uses the same shape over batch school types).
 *
 * For every audience track, `applies` says whether a given resource row
 * covers it; the verdict distinguishes three situations the UI must render
 * differently: fully covered (OK), present but with at least one audience
 * track uncovered (TRACK_INCOMPLETE), and nothing present at all (MISSING).
 */
function audienceCoverage<T>(
  audience: readonly SchoolType[],
  rows: readonly T[],
  applies: (row: T, track: SchoolType) => boolean
): { covered: boolean; present: boolean; missingTracks: readonly SchoolType[] } {
  const missingTracks = audience.filter(
    (t) => !rows.some((r) => applies(r, t))
  );
  return {
    covered: missingTracks.length === 0,
    present: rows.length > 0,
    missingTracks,
  };
}

/**
 * THE readiness computation — pure, deterministic, total, UI-free.
 *
 * It takes an already-loaded lesson and returns the checklist. `getLessonReadiness`
 * is the only production loader for the shape, and both the readiness endpoint
 * and the OPEN ceremony call THIS function, so the two can never disagree.
 */
export function computeLessonReadiness(
  input: ReadinessLessonInput
): LessonReadiness {
  const status = normalizeLessonStatus(input.status) ?? "DRAFT";
  const curriculumStatus =
    typeof input.curriculumStatus === "string"
      ? input.curriculumStatus.trim().toUpperCase()
      : null;
  const archived = curriculumStatus === "ARCHIVED";
  const trackScope = normalizeTrackScope(input.trackScope) ?? "SHARED";
  const officialCode =
    typeof input.officialCode === "string" && input.officialCode.trim()
      ? input.officialCode.trim()
      : null;

  const items: ReadinessItem[] = [];
  const notes: string[] = [];

  // ---- VIDEO -------------------------------------------------------------
  // Phase D: the MODERN SessionVideo authority is the ONLY video readiness
  // source. Legacy `Lesson.videoUrl` is read for one purpose only — telling
  // the admin why an old link no longer counts (a note, never credit).
  const legacyVideo = usableUrl(input.videoUrl);
  const videos = Array.isArray(input.sessionVideos) ? input.sessionVideos : [];
  const audience = audienceTracksForScope(trackScope);
  const publishedForAudience = videos.filter(
    (v) =>
      v?.isPublished === true &&
      audience.includes(normalizeSchoolType(v?.batch?.schoolType) as SchoolType)
  );
  const unpublishedSeen = videos.some(
    (v) =>
      v?.isPublished !== true &&
      audience.includes(normalizeSchoolType(v?.batch?.schoolType) as SchoolType)
  );
  const coveredTracks = new Set(
    publishedForAudience.map(
      (v) => normalizeSchoolType(v?.batch?.schoolType) as SchoolType
    )
  );
  const videoTracksMissing = audience.filter((t) => !coveredTracks.has(t));
  const videoPresent = publishedForAudience.length > 0;
  const videoSatisfied = videoTracksMissing.length === 0;
  if (!videoPresent && unpublishedSeen) {
    notes.push("VIDEO_PRESENT_BUT_UNPUBLISHED");
  }
  for (const missing of videoTracksMissing) {
    if (videoPresent) notes.push(`SHARED_VIDEO_MISSING_BATCH:${missing}`);
  }
  if (legacyVideo && !videoSatisfied) {
    notes.push("VIDEO_LEGACY_URL_NOT_COUNTED");
  }
  items.push({
    key: "VIDEO",
    required: true,
    present: videoPresent,
    valid: videoSatisfied,
    state: videoSatisfied
      ? "OK"
      : videoPresent
        ? // present, but not for the whole audience the lesson claims
          "INVALID"
        : "MISSING",
    code: videoSatisfied
      ? "VIDEO_OK"
      : videoPresent
        ? "VIDEO_TRACK_INCOMPLETE"
        : "VIDEO_MISSING",
    count: publishedForAudience.length,
  });

  // ---- PDF / MATERIAL (Phase 14 architecture, REQUIRED since Phase D) -----
  // A lesson needs at least one valid lesson-linked academic Material:
  // ACTIVE + document-like (`kind === "ADMIN_UPLOADED"` or carrying a media
  // asset) + covering the lesson's audience tracks. Legacy `Lesson.pdfUrl`
  // is compatibility-only: reported as a note when it is the only thing
  // present, never credited as content.
  const legacyPdf = usableUrl(input.pdfUrl);
  const materials = (Array.isArray(input.materials) ? input.materials : []).filter(
    (m) => m?.isActive !== false
  );
  const documentMaterials = materials.filter(
    (m) => m?.kind === "ADMIN_UPLOADED" || m?.kind === "DOCUMENT" || !!m?.mediaAssetId
  );
  // Materials without a trackScope are treated as SHARED (schema default).
  const materialApplies = (m: (typeof documentMaterials)[number], t: SchoolType) =>
    resourceAppliesToScope(t, m?.trackScope ?? "SHARED");
  const pdfCoverage = audienceCoverage(audience, documentMaterials, materialApplies);
  const applicableDocuments = documentMaterials.filter((m) =>
    audience.some((t) => materialApplies(m, t))
  );
  const foreignDocuments = documentMaterials.length - applicableDocuments.length;
  if (foreignDocuments > 0) {
    notes.push(`PDF_PRESENT_BUT_OTHER_TRACK:${foreignDocuments}`);
  }
  for (const missing of pdfCoverage.missingTracks) {
    if (applicableDocuments.length > 0) notes.push(`PDF_MISSING_TRACK:${missing}`);
  }
  if (legacyPdf && !pdfCoverage.covered) {
    notes.push("PDF_LEGACY_URL_NOT_COUNTED");
  }
  // "Present" follows the VIDEO convention: present FOR THE LESSON'S
  // AUDIENCE. A document that only belongs to another track is somebody
  // else's content — MISSING with an explanatory note, not a partial credit.
  const pdfPresent = applicableDocuments.length > 0;
  const pdfSatisfied = pdfCoverage.covered;
  items.push({
    key: "PDF",
    required: true,
    present: pdfPresent,
    valid: pdfSatisfied,
    state: pdfSatisfied ? "OK" : pdfPresent ? "INVALID" : "MISSING",
    code: pdfSatisfied
      ? "PDF_OK"
      : pdfPresent
        ? "PDF_TRACK_INCOMPLETE"
        : "PDF_MISSING",
    count: applicableDocuments.length,
  });

  // ---- QUIZ (REQUIRED since Phase D) --------------------------------------
  // A valid linked quiz must exist for EVERY audience track of the lesson:
  // an ARABIC-only quiz never satisfies a LANGUAGE lesson, and a SHARED
  // lesson needs a SHARED quiz or one quiz per track. A quiz is valid only
  // when its question count is readable and at least one.
  const quizzes = Array.isArray(input.quizzes) ? input.quizzes : [];
  const quizzesCovering = (t: SchoolType) =>
    quizzes.filter((q) => resourceAppliesToScope(t, q?.trackScope));
  const quizTrackStatus = audience.map((t) => {
    const covering = quizzesCovering(t);
    const validCount = covering.filter(
      (q) => (questionCountOf(q) ?? 0) > 0
    ).length;
    return {
      track: t,
      present: covering.length > 0,
      satisfied: validCount > 0,
    };
  });
  const applicableQuizzes = quizzes.filter((q) =>
    audience.some((t) => resourceAppliesToScope(t, q?.trackScope))
  );
  const foreignQuizzes = quizzes.length - applicableQuizzes.length;
  if (foreignQuizzes > 0) {
    notes.push(`QUIZ_PRESENT_BUT_OTHER_TRACK:${foreignQuizzes}`);
  }
  const quizUncoveredTracks = quizTrackStatus
    .filter((s) => !s.present)
    .map((s) => s.track);
  const quizInvalidTracks = quizTrackStatus
    .filter((s) => s.present && !s.satisfied)
    .map((s) => s.track);
  for (const t of quizInvalidTracks) {
    notes.push(`QUIZ_INVALID_FOR_TRACK:${t}`);
  }
  if (applicableQuizzes.length > 0) {
    for (const t of quizUncoveredTracks) {
      notes.push(`QUIZ_MISSING_TRACK:${t}`);
    }
  }
  // Same present/state convention as VIDEO/PDF: present FOR THE AUDIENCE;
  // a quiz that only exists on another track is MISSING (with a note).
  const quizPresent = applicableQuizzes.length > 0;
  const quizSatisfied = quizTrackStatus.every((s) => s.satisfied);
  items.push({
    key: "QUIZ",
    required: true,
    present: quizPresent,
    valid: quizSatisfied,
    state: quizSatisfied ? "OK" : quizPresent ? "INVALID" : "MISSING",
    code: quizSatisfied
      ? "QUIZ_OK"
      : !quizPresent
        ? "QUIZ_MISSING"
        : quizInvalidTracks.length > 0
          ? // covering quizzes exist but none is usable (empty / unreadable)
            "QUIZ_EMPTY"
          : // quizzes exist for part of the audience only
            "QUIZ_TRACK_INCOMPLETE",
    count: applicableQuizzes.length,
  });

  // ---- HOMEWORK (REQUIRED since Phase D) ----------------------------------
  // Same coverage rule as QUIZ: every audience track of the lesson needs a
  // linked homework with actionable instructions (empty or placeholder
  // instructions are an assignment a student cannot act on — invalid).
  const homeworks = Array.isArray(input.homeworks) ? input.homeworks : [];
  const homeworkTrackStatus = audience.map((t) => {
    const covering = homeworks.filter((h) =>
      resourceAppliesToScope(t, h?.trackScope)
    );
    const validCount = covering.filter((h) =>
      usableInstructionText(h?.instructions)
    ).length;
    return {
      track: t,
      present: covering.length > 0,
      satisfied: validCount > 0,
    };
  });
  const applicableHomeworks = homeworks.filter((h) =>
    audience.some((t) => resourceAppliesToScope(t, h?.trackScope))
  );
  const foreignHomeworks = homeworks.length - applicableHomeworks.length;
  if (foreignHomeworks > 0) {
    notes.push(`HOMEWORK_PRESENT_BUT_OTHER_TRACK:${foreignHomeworks}`);
  }
  const homeworkUncoveredTracks = homeworkTrackStatus
    .filter((s) => !s.present)
    .map((s) => s.track);
  const homeworkInvalidTracks = homeworkTrackStatus
    .filter((s) => s.present && !s.satisfied)
    .map((s) => s.track);
  for (const t of homeworkInvalidTracks) {
    notes.push(`HOMEWORK_INVALID_FOR_TRACK:${t}`);
  }
  if (applicableHomeworks.length > 0) {
    for (const t of homeworkUncoveredTracks) {
      notes.push(`HOMEWORK_MISSING_TRACK:${t}`);
    }
  }
  // Same present/state convention as VIDEO/PDF/QUIZ.
  const homeworkPresent = applicableHomeworks.length > 0;
  const homeworkSatisfied = homeworkTrackStatus.every((s) => s.satisfied);
  items.push({
    key: "HOMEWORK",
    required: true,
    present: homeworkPresent,
    valid: homeworkSatisfied,
    state: homeworkSatisfied ? "OK" : homeworkPresent ? "INVALID" : "MISSING",
    code: homeworkSatisfied
      ? "HOMEWORK_OK"
      : !homeworkPresent
        ? "HOMEWORK_MISSING"
        : homeworkInvalidTracks.length > 0
          ? "HOMEWORK_INSTRUCTIONS_EMPTY"
          : "HOMEWORK_TRACK_INCOMPLETE",
    count: applicableHomeworks.length,
  });

  // ---- verdict -----------------------------------------------------------
  const blocking: string[] = [];
  if (archived) blocking.push("CURRICULUM_ARCHIVED");
  for (const item of items) {
    if (item.state === "MISSING" || item.state === "INVALID") {
      blocking.push(item.code);
    }
  }
  // Deterministic, human-stable ordering: the fixed resource order first, then
  // any lifecycle-level code — so a client can diff two snapshots literally.
  blocking.sort((a, b) => readinessCodeRank(a) - readinessCodeRank(b));

  const canBeReady = blocking.length === 0;
  return {
    lessonId: typeof input.id === "string" ? input.id : null,
    officialCode,
    status,
    curriculumStatus,
    archived,
    trackScope,
    items,
    canBeReady,
    canPublish: canBeReady,
    blocking,
    notes: [...new Set(notes)].sort(),
  };
}

function usableInstructionText(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return v.length > 0 && !PLACEHOLDER_MARKERS.has(v.toLowerCase());
}

function readinessCodeRank(code: string): number {
  const idx = READINESS_RESOURCES.findIndex((k) => code.startsWith(k));
  return idx === -1 ? -1 : idx;
}

// ---------------------------------------------------------------------------
// Loading (the ONLY readiness loader)
// ---------------------------------------------------------------------------

/** The exact lesson shape readiness needs. Shared by the endpoints. */
export const READINESS_LESSON_INCLUDE = {
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
  publication: { select: { id: true, segment: true, publishedAt: true } },
} as const;

/**
 * What the loader returns: the pure readiness verdict plus the two pieces of
 * stored lifecycle state the admin payload reports (the publication anchor
 * and the deprecated mirror). Kept OUT of `LessonReadiness` so the computation
 * itself stays free of anything it does not evaluate.
 */
export type LessonReadinessSnapshot = LessonReadiness & {
  /** DEPRECATED compat mirror of `status === PUBLISHED`. Reported, never obeyed. */
  isPublished: boolean;
  publication: {
    id: string;
    segment: string;
    publishedAt: Date | string;
  } | null;
};

/**
 * Load a lesson and compute its readiness with the REAL query. Returns `null`
 * for a lesson that does not exist — the callers turn that into a 404, and it
 * is the same answer an out-of-scope id gets from every student surface, so
 * the admin API cannot become an existence oracle for other systems.
 */
export async function getLessonReadiness(
  lessonId: string,
  // Deliberately client-injectable (tests, CLI, and `db`), same convention as
  // `official-curriculum.ts`, so the injected client is structural by design.
  client: any = db
): Promise<LessonReadinessSnapshot | null> {
  const lesson = await client.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      status: true,
      curriculumStatus: true,
      trackScope: true,
      officialCode: true,
      videoUrl: true,
      pdfUrl: true,
      isPublished: true,
      ...READINESS_LESSON_INCLUDE,
    },
  });
  if (!lesson) return null;
  const readiness = computeLessonReadiness(lesson);
  return {
    ...readiness,
    // The deprecated mirror, carried for the ADMIN payload only (it is
    // reported, never obeyed — no code path reads it to decide anything).
    isPublished: lesson.isPublished === true,
    publication: lesson.publication
      ? {
          id: lesson.publication.id,
          segment: String(lesson.publication.segment),
          publishedAt: lesson.publication.publishedAt,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// The ceremonies (mark-ready / open / unpublish)
// ---------------------------------------------------------------------------
//
// Every mutation of `status` in the platform goes through `transitionLesson`,
// which is transactional, idempotent, readiness-aware and audit-writing. Routes
// stay thin; the rules live here so no endpoint can implement them slightly
// differently. There is deliberately NO exported "set status" helper.

export type LifecycleAction = "MARK_READY" | "OPEN" | "UNPUBLISH";

/** Machine-readable outcome codes — the API's stable contract. */
export type LifecycleCode =
  /** the transition was applied */
  | "OK"
  /** already in the requested state: nothing written, nothing re-published */
  | "NO_OP_ALREADY_IN_STATE"
  /** readiness does not permit it — see `blocking` */
  | "READINESS_BLOCKED"
  /** the (from → to) pair is not in the state machine */
  | "ILLEGAL_TRANSITION"
  /** archived lessons have no lifecycle to run */
  | "LESSON_ARCHIVED"
  /** the lesson is attached to no course, so there is no curriculum to open */
  | "LESSON_NOT_IN_COURSE"
  | "LESSON_NOT_FOUND"
  /** a concurrent ceremony won the race; the caller may retry */
  | "CONCURRENT_CHANGE"
  /** Phase D — the emergency override reason was absent/blank/too long */
  | "OVERRIDE_REASON_INVALID";

/** Phase D — the audited record attached to an override-involved OPEN. */
export type LifecycleOverrideInfo = {
  /** true when the override actually bypassed readiness; false when the
   * override was requested but readiness passed, so the NORMAL path ran. */
  used: boolean;
  /** The validated, trimmed reason (never empty when `used`). */
  reason: string;
  /** The readiness codes the override bypassed (empty when not used). */
  missing: string[];
};

export type LifecycleOutcome = {
  ok: boolean;
  code: LifecycleCode;
  action: LifecycleAction;
  lessonId: string;
  from: LessonStatus | null;
  to: LessonStatus | null;
  /** true when THIS call flipped the row (false on every idempotent replay) */
  changed: boolean;
  message: string;
  /** The live checklist at the moment of the ceremony (null when the lesson
   * could not be loaded at all). */
  readiness: LessonReadinessSnapshot | null;
  publication: { id: string; segment: string; publishedAt: Date | string } | null;
  /** Phase D — set only for override-involved OPEN ceremonies; `null` for
   * every normal ceremony, so a normal path can never masquerade as one. */
  override?: LifecycleOverrideInfo | null;
};

const ACTION_TARGET: Record<LifecycleAction, LessonStatus> = {
  MARK_READY: "READY",
  OPEN: "PUBLISHED",
  UNPUBLISH: "READY",
};

/** The state a lesson must already be in for the action to apply. */
const ACTION_FROM: Record<LifecycleAction, readonly LessonStatus[]> = {
  MARK_READY: ["DRAFT", "READY"],
  // READY only: DRAFT must be staged first, which is what makes
  // "READY cannot be bypassed" a machine-checked property rather than a slogan.
  // The ONE exception is the Phase D emergency override, which stages
  // DRAFT→READY inside its own audited ceremony — never through this table.
  OPEN: ["READY"],
  UNPUBLISH: ["PUBLISHED", "READY", "DRAFT"],
} as const;

// ---------------------------------------------------------------------------
// Phase D — emergency override input contract
// ---------------------------------------------------------------------------

/** Hard cap on the override reason. The text is stored in an AuditLog row;
 * the cap keeps the row small while leaving room for a real explanation. */
export const OVERRIDE_REASON_MAX_LENGTH = 1000;

export type OverrideReasonParse =
  | { ok: true; reason: string }
  | { ok: false; code: "OVERRIDE_REASON_REQUIRED" | "OVERRIDE_REASON_TOO_LONG" };

/**
 * The override reason is the human warrant for bypassing readiness, so it is
 * validated like an input, not treated like a formality: a missing, empty or
 * whitespace-only reason is REJECTED, and a reason over the cap is rejected
 * rather than silently truncated (silent truncation would let the audit row
 * disagree with what the admin typed).
 */
export function normalizeOverrideReason(raw: unknown): OverrideReasonParse {
  if (typeof raw !== "string") return { ok: false, code: "OVERRIDE_REASON_REQUIRED" };
  const reason = raw.trim();
  if (reason.length === 0) return { ok: false, code: "OVERRIDE_REASON_REQUIRED" };
  if (reason.length > OVERRIDE_REASON_MAX_LENGTH) {
    return { ok: false, code: "OVERRIDE_REASON_TOO_LONG" };
  }
  return { ok: true, reason };
}

/**
 * The lifecycle ceremony. `actorUserId` keys the audit row; `client` is
 * injectable so the tests, a future CLI and the API all exercise the SAME
 * implementation (no parallel engine).
 */
export async function transitionLesson(params: {
  lessonId: string;
  action: LifecycleAction;
  actorUserId?: string | null;
  // Injected clients are structural, not nominal — see `getLessonReadiness`.
  client?: any;
  /**
   * Phase D — the ADMIN emergency override. ONLY meaningful for `OPEN`:
   * `{ reason }` lets the ceremony publish a lesson whose readiness is
   * blocked (staging DRAFT→READY inside the same atomic ceremony when
   * needed). It never bypasses the archived/orphan/concurrency rules, never
   * applies to MARK_READY or UNPUBLISH, and it is validated, reason-bearing
   * and audited — see `openLessonWithOverride`.
   */
  override?: { reason: string } | null;
}): Promise<LifecycleOutcome> {
  const client = params.client ?? db;
  const { lessonId, action, actorUserId = null } = params;
  const to = ACTION_TARGET[action];
  const overrideRequest = action === "OPEN" ? params.override ?? null : null;

  const load = async (where: Record<string, unknown>) =>
    client.lesson.findUnique({
      where,
      select: {
        id: true,
        status: true,
        curriculumStatus: true,
        trackScope: true,
        title: true,
        officialCode: true,
        unitId: true,
        topicId: true,
      },
    });

  const lesson = await load({ id: lessonId });
  if (!lesson) {
    return {
      ok: false,
      code: "LESSON_NOT_FOUND",
      action,
      lessonId,
      from: null,
      to: null,
      changed: false,
      message: "Lesson not found",
      readiness: null,
      publication: null,
    };
  }

  const from = normalizeLessonStatus(lesson.status) ?? "DRAFT";
  const curriculumStatus =
    typeof lesson.curriculumStatus === "string"
      ? lesson.curriculumStatus.toUpperCase()
      : null;
  const archived = curriculumStatus === "ARCHIVED";

  const refusal = (
    code: LifecycleCode,
    message: string,
    readiness: LessonReadinessSnapshot | null = null
  ): LifecycleOutcome => ({
    ok: false,
    code,
    action,
    lessonId,
    from,
    to: null,
    changed: false,
    message,
    readiness,
    publication: null,
  });

  // Rule order is part of the contract: override INPUT validation first
  // (Phase D — a malformed warrant is rejected before any state is even
  // looked at), then archived (an archived lesson is outside the lifecycle
  // entirely), then course ownership, then idempotency, then the transition
  // table, then readiness. Reordering them would change which refusal a
  // caller sees for a lesson that fails several rules, and the tests pin
  // this order deliberately.
  let overrideReason: string | null = null;
  if (overrideRequest) {
    const parsedReason = normalizeOverrideReason(overrideRequest.reason);
    if (!parsedReason.ok) {
      return refusal(
        "OVERRIDE_REASON_INVALID",
        parsedReason.code === "OVERRIDE_REASON_TOO_LONG"
          ? `The override reason is too long (maximum ${OVERRIDE_REASON_MAX_LENGTH} characters)`
          : "An emergency override requires a non-empty reason"
      );
    }
    overrideReason = parsedReason.reason;
  }

  if (archived) {
    return refusal(
      "LESSON_ARCHIVED",
      "An archived lesson is curriculum history and cannot change lifecycle state"
    );
  }

  // Ownership: a session the curriculum does not contain cannot be opened
  // into it. Canonical `unitId` chain first, legacy `topicId` chain as the
  // fallback — the same resolution order the progression engine uses, so the
  // ceremony never disagrees with the gate.
  const inCourse = !!lesson.unitId || !!lesson.topicId;
  if (!inCourse) {
    return refusal(
      "LESSON_NOT_IN_COURSE",
      "The lesson is not attached to a unit or topic, so it belongs to no curriculum"
    );
  }

  const target = to;
  if (from === target) {
    // Idempotent replay: report the state that already holds. For OPEN this is
    // the second-call contract — no second publish, no duplicate row, no
    // notification, and the existing publication is returned unchanged.
    const publication = await client.sessionPublication
      .findUnique({
        where: { lessonId },
        select: { id: true, segment: true, publishedAt: true },
      })
      .catch(() => null);
    return {
      ok: true,
      code: "NO_OP_ALREADY_IN_STATE",
      action,
      lessonId,
      from,
      to: from,
      changed: false,
      message:
        action === "OPEN"
          ? "Lesson is already published"
          : `Lesson is already ${from.toLowerCase()}`,
      readiness: await readinessFor(client, lessonId),
      publication: publication
        ? {
            id: publication.id,
            segment: String(publication.segment),
            publishedAt: publication.publishedAt,
          }
        : null,
      // Nothing was overridden: the state already held.
      override: null,
    };
  }

  // Phase D — an ENGAGED override (validated reason + OPEN) is the one
  // sanctioned exception to "READY cannot be bypassed": it may start from
  // DRAFT because it stages DRAFT→READY inside its own audited ceremony.
  // Everything outside that narrow case obeys the table exactly.
  const overrideEngaged = action === "OPEN" && overrideReason !== null;
  const transitionAllowed =
    ACTION_FROM[action].includes(from) && canTransition(from, target);
  if (
    !transitionAllowed &&
    !(overrideEngaged && (from === "DRAFT" || from === "READY"))
  ) {
    return refusal(
      "ILLEGAL_TRANSITION",
      `${from} → ${target} is not a valid lifecycle transition`
    );
  }

  // Readiness is computed from the LIVE rows at the moment of the ceremony —
  // never from a client-supplied flag, and never from the snapshot the READY
  // stamp was earned with. A lesson that lost its video since staging cannot
  // be opened.
  const readiness = await readinessFor(client, lessonId);
  if (!readiness) {
    return refusal("LESSON_NOT_FOUND", "Lesson not found");
  }
  const needsReadiness = action === "MARK_READY" || action === "OPEN";
  if (needsReadiness && overrideEngaged && overrideReason !== null) {
    // Phase D — the EMERGENCY path is ONE ceremony for every override-engaged
    // OPEN: it re-validates from live rows, stages DRAFT→READY inside the
    // same transaction when needed (so "READY cannot be bypassed" holds even
    // here), and reports `override.used` truthfully — false when readiness
    // actually passed and nothing was bypassed. Every other rule (archived,
    // course ownership, idempotency, concurrency) still applies.
    return applyOverrideOpen({
      client,
      lessonId,
      from,
      lesson,
      readiness,
      reason: overrideReason,
      actorUserId,
    });
  }
  if (needsReadiness && !readiness.canBeReady) {
    return refusal(
      "READINESS_BLOCKED",
      `Readiness contract not satisfied: ${readiness.blocking.join(", ")}`,
      readiness
    );
  }

  // ---- apply ------------------------------------------------------------
  const apply = async (tx: Prisma.TransactionClient) => {
    // Conditional flip: the `status: from` predicate is what makes a concurrent
    // ceremony impossible to double-apply. Losing it is a silent corruption,
    // not a race.
    const updated = await tx.lesson.updateMany({
      where: { id: lessonId, status: from },
      data: { status: target, isPublished: publishedMirror(target) },
    });
    if (updated.count !== 1) {
      return { kind: "CONCURRENT_CHANGE" as const };
    }

    let publication: { id: string; segment: string; publishedAt: Date | string } | null =
      null;
    if (target === "PUBLISHED") {
      const segment = normalizeTrackScope(lesson.trackScope) ?? "SHARED";
      // The unique key is what makes a retried ceremony physically incapable
      // of creating a second publication of the same lesson.
      const row = await tx.sessionPublication.upsert({
        where: { lessonId },
        update: {},
        create: { lessonId, segment },
        select: { id: true, segment: true, publishedAt: true },
      });
      publication = row
        ? { id: row.id, segment: String(row.segment), publishedAt: row.publishedAt }
        : null;
    } else if (target === "READY" && action === "UNPUBLISH") {
      // Unpublishing WITHDRAWS the publication: Phase 17 must never fan out a
      // notification for a session that is no longer in the universe, so the
      // anchor goes. The AuditLog keeps the full history of both acts.
      await tx.sessionPublication
        .deleteMany({ where: { lessonId } })
        .catch(() => undefined);
    }

    if (actorUserId) {
      await tx.auditLog
        .create({
          data: {
            userId: actorUserId,
            action: `LESSON_${action}`,
            entity: "Lesson",
            entityId: lessonId,
            details: JSON.stringify({
              from,
              to: target,
              officialCode: lesson.officialCode ?? null,
              curriculumStatus,
              trackScope: readiness.trackScope,
              blocking: readiness.blocking,
              publicationId: publication?.id ?? null,
            }).slice(0, 1000),
          },
        })
        .catch(() => undefined); // an audit insert must never fail the ceremony
    }
    return { kind: "APPLIED" as const, publication };
  };

  // The transaction is the ceremony's atomicity boundary: the flip, the
  // publication row and the audit row either all exist or none do. A client
  // without `$transaction` (a test harness) is supported explicitly rather
  // than silently reordering the writes.
  let result: Awaited<ReturnType<typeof apply>>;
  if (typeof client.$transaction === "function") {
    result = await client.$transaction(apply);
  } else {
    result = await apply(client);
  }

  if (result.kind === "CONCURRENT_CHANGE") {
    return {
      ok: false,
      code: "CONCURRENT_CHANGE",
      action,
      lessonId,
      from,
      to: null,
      changed: false,
      message: "The lesson changed while this request was in flight; retry",
      readiness: await readinessFor(client, lessonId),
      publication: null,
    };
  }

  return {
    ok: true,
    code: "OK",
    action,
    lessonId,
    from,
    to: target,
    changed: true,
    message:
      target === "PUBLISHED"
        ? "Lesson published"
        : `Lesson set to ${target.toLowerCase()}`,
    readiness: await readinessFor(client, lessonId),
    publication: result.publication ?? null,
    // No override ever rides the normal path: override-engaged OPENs return
    // from `applyOverrideOpen` above, so reaching here means no bypass.
    override: null,
  };
}

// ---------------------------------------------------------------------------
// Phase D — the emergency override ceremony (admin-only, audited, explicit)
// ---------------------------------------------------------------------------
//
// THE ONLY code path that can publish a readiness-blocked lesson. It is a
// ceremony, not a flag:
//
//   • It runs AFTER archived / course-ownership / idempotency checks and
//     validated reason — the override bypasses READINESS ONLY. It can never
//     bypass permissions (the route owns ADMIN enforcement), the state
//     machine for any other pair, or student progression (a published
//     lesson is still LOCKED until its prerequisites are met).
//   • From DRAFT it stages DRAFT→READY→PUBLISHED inside ONE transaction,
//     so the lesson never exists half-staged and the audit trail shows the
//     staging as part of the override.
//   • It writes THREE audit rows when it stages (LESSON_MARK_READY marked
//     via override, LESSON_OPEN marked via override) and ALWAYS writes the
//     dedicated `LESSON_OPEN_OVERRIDE` row carrying the admin id (userId
//     column), the lesson (entityId), the timestamp (createdAt), the
//     MISSING requirements, the REASON and the resulting state — the
//     traceability contract repeated overrides must never escape.
async function applyOverrideOpen(params: {
  client: any;
  lessonId: string;
  from: LessonStatus;
  lesson: { officialCode?: string | null; trackScope?: unknown };
  readiness: LessonReadinessSnapshot;
  reason: string;
  actorUserId: string | null;
}): Promise<LifecycleOutcome> {
  const { client, lessonId, from, lesson, readiness, reason, actorUserId } =
    params;
  // The truth the audit must carry: did this ceremony actually bypass
  // readiness, or was the override requested against a lesson that passed?
  const used = !readiness.canBeReady;
  const missing = readiness.blocking;

  const apply = async (tx: Prisma.TransactionClient) => {
    // Conditional flips only — the `status` predicate is what makes a
    // concurrent ceremony impossible to double-apply.
    if (from === "DRAFT") {
      const staged = await tx.lesson.updateMany({
        where: { id: lessonId, status: "DRAFT" },
        data: { status: "READY", isPublished: false },
      });
      if (staged.count !== 1) return { kind: "CONCURRENT_CHANGE" as const };
    }
    const published = await tx.lesson.updateMany({
      where: { id: lessonId, status: "READY" },
      data: { status: "PUBLISHED", isPublished: true },
    });
    if (published.count !== 1) return { kind: "CONCURRENT_CHANGE" as const };

    const segment = normalizeTrackScope(lesson.trackScope) ?? "SHARED";
    const row = await tx.sessionPublication.upsert({
      where: { lessonId },
      update: {},
      create: { lessonId, segment },
      select: { id: true, segment: true, publishedAt: true },
    });
    const publication = row
      ? { id: row.id, segment: String(row.segment), publishedAt: row.publishedAt }
      : null;

    if (actorUserId) {
      const baseDetails = {
        officialCode: lesson.officialCode ?? null,
        trackScope: readiness.trackScope,
        override: true,
        overrideUsed: used,
      };
      const auditWrites: Promise<unknown>[] = [];
      if (from === "DRAFT") {
        auditWrites.push(
          tx.auditLog
            .create({
              data: {
                userId: actorUserId,
                action: "LESSON_MARK_READY",
                entity: "Lesson",
                entityId: lessonId,
                details: JSON.stringify({
                  from: "DRAFT",
                  to: "READY",
                  via: "EMERGENCY_OVERRIDE",
                  ...baseDetails,
                }).slice(0, 1000),
              },
            })
            .catch(() => undefined)
        );
      }
      auditWrites.push(
        tx.auditLog
          .create({
            data: {
              userId: actorUserId,
              action: "LESSON_OPEN",
              entity: "Lesson",
              entityId: lessonId,
              details: JSON.stringify({
                from,
                to: "PUBLISHED",
                publicationId: publication?.id ?? null,
                ...baseDetails,
              }).slice(0, 1000),
            },
          })
          .catch(() => undefined),
        // THE override record: who (userId column), what (entityId), when
        // (createdAt), what was missing, why, and the resulting state. One
        // row per override-engaged open, so repeated overrides stay
        // individually traceable in the history — even a requested override
        // that turned out to bypass nothing (`missing: []`).
        tx.auditLog
          .create({
            data: {
              userId: actorUserId,
              action: "LESSON_OPEN_OVERRIDE",
              entity: "Lesson",
              entityId: lessonId,
              details: JSON.stringify({
                from,
                to: "PUBLISHED",
                used,
                missing,
                reason,
                publicationId: publication?.id ?? null,
                ...baseDetails,
              }).slice(0, 4000),
            },
          })
          .catch(() => undefined)
      );
      await Promise.all(auditWrites);
    }
    return { kind: "APPLIED" as const, publication };
  };

  let result: Awaited<ReturnType<typeof apply>>;
  if (typeof client.$transaction === "function") {
    result = await client.$transaction(apply);
  } else {
    result = await apply(client);
  }

  if (result.kind === "CONCURRENT_CHANGE") {
    return {
      ok: false,
      code: "CONCURRENT_CHANGE",
      action: "OPEN",
      lessonId,
      from,
      to: null,
      changed: false,
      message: "The lesson changed while this request was in flight; retry",
      readiness: await readinessFor(client, lessonId),
      publication: null,
      override: { used: false, reason, missing },
    };
  }

  return {
    ok: true,
    code: "OK",
    action: "OPEN",
    lessonId,
    from,
    to: "PUBLISHED",
    changed: true,
    message: used
      ? "Lesson published via emergency override"
      : "Lesson published (override requested; readiness passed — nothing bypassed)",
    readiness: await readinessFor(client, lessonId),
    publication: result.publication ?? null,
    override: { used, reason, missing },
  };
}

async function readinessFor(
  // Injected clients are structural, not nominal — see `getLessonReadiness`.
  client: any,
  lessonId: string
): Promise<LessonReadinessSnapshot | null> {
  const loaded = await getLessonReadiness(lessonId, client);
  return loaded ?? null;
}

/**
 * The single HTTP mapping for a ceremony outcome, shared by every lifecycle
 * endpoint so `open`, `mark-ready` and `unpublish` cannot answer a refusal with
 * three different statuses:
 *
 *   LESSON_NOT_FOUND        → 404  (never distinguish "no such lesson" from
 *                                  "no such lesson for you" to a caller that
 *                                  should not be probing ids at all)
 *   READINESS_BLOCKED       → 409  (the resource exists; it is not complete)
 *   ILLEGAL_TRANSITION      → 409  (the state machine refused it)
 *   LESSON_ARCHIVED         → 409  (lifecycle does not apply to history)
 *   LESSON_NOT_IN_COURSE    → 409  (nothing to publish INTO)
 *   CONCURRENT_CHANGE       → 409  (retry-safe; not 500 — nothing broke)
 *
 * `code` is always in the body: the number is for HTTP semantics, the code is
 * for programs. A client must never have to parse prose.
 */
export function lifecycleHttpStatus(code: LifecycleCode): 200 | 400 | 404 | 409 {
  if (code === "OK" || code === "NO_OP_ALREADY_IN_STATE") return 200;
  if (code === "OVERRIDE_REASON_INVALID") return 400;
  if (code === "LESSON_NOT_FOUND") return 404;
  return 409;
}

/** Convenience wrappers used by the admin API (and by nothing else). */
export function openLesson(params: {
  lessonId: string;
  actorUserId?: string | null;
  // Injected clients are structural, not nominal — see `getLessonReadiness`.
  client?: any;
}) {
  // The normal OPEN never carries an override — that path has its own
  // wrapper, its own route and its own audit row, on purpose.
  return transitionLesson({ ...params, action: "OPEN" });
}

/**
 * Phase D — the ADMIN EMERGENCY override of the OPEN ceremony. The ONLY
 * sanctioned way to publish a readiness-blocked lesson. The reason is
 * validated server-side (never trust the client's "I checked it"), the
 * readiness is re-computed from live rows, and the outcome is audited as
 * `LESSON_OPEN_OVERRIDE`. When readiness actually passes, the NORMAL
 * ceremony runs and `override.used` is false — the override never turns
 * into a silent bypass of anything.
 */
export function openLessonWithOverride(params: {
  lessonId: string;
  actorUserId?: string | null;
  reason: string;
  // Injected clients are structural, not nominal — see `getLessonReadiness`.
  client?: any;
}) {
  const { reason, ...rest } = params;
  return transitionLesson({
    ...rest,
    action: "OPEN",
    override: { reason },
  });
}

export function markLessonReady(params: {
  lessonId: string;
  actorUserId?: string | null;
  // Injected clients are structural, not nominal — see `getLessonReadiness`.
  client?: any;
}) {
  return transitionLesson({ ...params, action: "MARK_READY" });
}

export function unpublishLesson(params: {
  lessonId: string;
  actorUserId?: string | null;
  // Injected clients are structural, not nominal — see `getLessonReadiness`.
  client?: any;
}) {
  return transitionLesson({ ...params, action: "UNPUBLISH" });
}

/**
 * The lifecycle projection returned to the admin surfaces. Staff-only: a
 * student response body must never carry a lifecycle field, because the
 * presence of `status` on a lesson they cannot open is itself information.
 */
export function lifecyclePayload<T extends { status?: unknown; isPublished?: unknown }>(
  lesson: T,
  extras: {
    readiness?: LessonReadiness | null;
    publication?: { id: string; segment: string; publishedAt: Date | string } | null;
  } = {}
) {
  const status = normalizeLessonStatus(lesson.status) ?? "DRAFT";
  return {
    status,
    lifecycle: {
      status,
      // Derived, never stored: readiness is a computation over live rows, so
      // the admin list can show it without a second source of truth.
      canBeReady: extras.readiness ? extras.readiness.canBeReady : null,
      canTransitionTo: (LESSON_STATUSES as readonly LessonStatus[]).filter((s) =>
        canTransition(status, s)
      ),
      publishedMirror: publishedMirror(status),
      // DEPRECATED compatibility field, echoed read-only for existing admin
      // consumers. It is not an input anywhere.
      isPublishedCompat: lesson.isPublished === true,
    },
    readiness: extras.readiness ?? null,
    publication: extras.publication ?? null,
  };
}
