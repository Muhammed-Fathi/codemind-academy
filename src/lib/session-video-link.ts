// CodeMind Academy — SessionVideo ↔ Lesson / Batch academic link validation
// (Phase A of the academic session workflow).
//
// THE IDENTITY MODEL (final product decision)
//   Lesson IS the canonical academic Session. A SessionVideo is:
//
//     SessionVideo
//     ├── lessonId     = the canonical Lesson / academic Session (ownership)
//     ├── batchId      = the audience / track (Batch.schoolType)
//     └── mediaAssetId = the uploaded or external media
//
// EVERY NEW video created through the canonical Admin flows (presigned direct
// upload, buffered fallback upload, external video URL) MUST carry a valid
// lessonId. This module is the SINGLE server-side authority that decides
// whether a (lesson, batch) pair may be the academic identity of a new
// SessionVideo row. All three creation paths call `validateSessionVideoLink`
// so they can never drift apart, and the presigned flow additionally signs
// the validated identity into the upload-intent token (src/lib/media-upload.ts)
// so it survives init → PUT → complete and cannot be swapped by the client.
//
// VALIDATION RULES (fail-closed, in order — no silent correction ever):
//   1. lessonId is present                    → LESSON_REQUIRED
//   2. the Lesson exists                      → LESSON_NOT_FOUND
//   3. the Lesson is not ARCHIVED             → LESSON_ARCHIVED
//   4. the Batch exists                       → BATCH_NOT_FOUND
//   5. the Batch declares a course → the Lesson must be of THE same course
//                                             → COURSE_MISMATCH
//   6. Lesson.trackScope fits Batch.schoolType→ TRACK_MISMATCH
//
// Track fit is the same predicate readiness applies (Phase 12/13): a SHARED
// lesson is eligible for BOTH batches; a track-specific lesson only for its
// own. So the video an admin can create for a batch is exactly the video the
// readiness engine will count for the lesson.
//
// LEGACY POLICY: existing rows with lessonId = null are untouched — no
// migration, no auto-assignment. They remain readable and deletable; only
// NEW rows are bound to a Lesson here.

import type { db } from "@/lib/db";
// Client-safe storage predicate (NOT @/lib/media: this module ships to the
// browser through session-video-picker, and @/lib/media is node-only).
import { isManagedPrivateStorage } from "@/lib/media-storage";
// Pure requirement-mode vocabulary (client-safe: no I/O, no node-only deps).
import { normalizeRequirementMode, type RequirementMode } from "./video-applicability";
import { normalizeSchoolType } from "@/lib/school-type";
import { normalizeTrackScope } from "@/lib/track-scope";

export const SESSION_VIDEO_LINK_ERRORS = {
  LESSON_REQUIRED: { status: 400, i18n: "api.313" },
  LESSON_NOT_FOUND: { status: 404, i18n: "api.314" },
  LESSON_ARCHIVED: { status: 409, i18n: "api.315" },
  BATCH_NOT_FOUND: { status: 404, i18n: "api.218" },
  COURSE_MISMATCH: { status: 400, i18n: "api.316" },
  TRACK_MISMATCH: { status: 400, i18n: "api.317" },
} as const;

export type SessionVideoLinkCode = keyof typeof SESSION_VIDEO_LINK_ERRORS;

export type SessionVideoLinkResult =
  | { ok: true; lessonId: string; batchId: string }
  | { ok: false; code: SessionVideoLinkCode; status: number; message: string };

/**
 * The exact lesson shape the check needs. The canonical course chain is
 * unit → part → course; the legacy chain is topic → unit → part → course.
 * Both are read so a legacy-chained lesson is judged by its real course, not
 * guessed.
 */
const LINK_LESSON_SELECT = {
  id: true,
  curriculumStatus: true,
  trackScope: true,
  unit: { select: { part: { select: { courseId: true } } } },
  topic: { select: { unit: { select: { part: { select: { courseId: true } } } } } },
} as const;

const LINK_BATCH_SELECT = {
  id: true,
  schoolType: true,
  courseId: true,
} as const;

/**
 * The database-client boundary of this validator — the repository's
 * established Prisma abstraction: `typeof db` (the generated PrismaClient),
 * exactly like `validateUploadTarget(client: typeof db, ...)` in
 * src/lib/media-upload.ts and every admin route that passes `db` around.
 *
 * Why this shape and NOT a handcrafted structural delegate: the generated
 * `lesson.findUnique` is a generic method
 * `<T extends LessonFindUniqueArgs>(args: SelectSubset<T, LessonFindUniqueArgs>)`,
 * and a hand-rolled `findUnique: (args: { where: { id: string }; select:
 * unknown }) => Promise<unknown>` property is NOT assignable from it under
 * `strictFunctionTypes` (TS2345: `select: unknown` does not satisfy the
 * generated `LessonSelect` constraint). Typing the boundary as the real
 * client keeps the validator's two `findUnique` calls fully type-checked by
 * Prisma's own machinery (args, select payload, result types) and is sound
 * for BOTH the `PrismaClient` and the interactive `$transaction` client —
 * they expose identical delegates. `Pick` keeps the declared dependency to
 * the two delegates this check actually queries. Test doubles inject at the
 * same boundary at runtime (JS), as in every other academic module.
 */
export type SessionVideoLinkClient = Pick<typeof db, "lesson" | "batch">;

function asTrimmedId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length > 0 ? v : null;
}

function linkError(
  code: SessionVideoLinkCode,
  message: string
): { ok: false; code: SessionVideoLinkCode; status: number; message: string } {
  return { ok: false, code, status: SESSION_VIDEO_LINK_ERRORS[code].status, message };
}

/**
 * The single academic-link validator for NEW session videos (and for any
 * explicit re-link of an existing one). See the rule list in the file header.
 * Returns the canonical (lessonId, batchId) pair when the link is valid —
 * the caller must persist EXACTLY this pair.
 */
export async function validateSessionVideoLink(
  client: SessionVideoLinkClient,
  input: { lessonId?: unknown; batchId?: unknown }
): Promise<SessionVideoLinkResult> {
  // 1. Every new video belongs to a Lesson — no exceptions, no guessing.
  const lessonId = asTrimmedId(input.lessonId);
  if (!lessonId) {
    return linkError(
      "LESSON_REQUIRED",
      "A lesson is required for every new session video"
    );
  }

  // 2. The Lesson exists …
  const lesson = (await client.lesson.findUnique({
    where: { id: lessonId },
    select: LINK_LESSON_SELECT,
  })) as
    | {
        id: string;
        curriculumStatus: string | null;
        trackScope: string | null;
        unit: { part: { courseId: string | null } | null } | null;
        topic: { unit: { part: { courseId: string | null } | null } | null } | null;
      }
    | null;
  if (!lesson) {
    return linkError("LESSON_NOT_FOUND", "The selected lesson does not exist");
  }

  // 3. … and is not archived. Archived curriculum is history, not a place
  //    where new recordings may land.
  if (String(lesson.curriculumStatus ?? "").trim().toUpperCase() === "ARCHIVED") {
    return linkError(
      "LESSON_ARCHIVED",
      "A session video cannot be linked to an archived lesson"
    );
  }

  // 4. The audience (batch) exists.
  const batchId = asTrimmedId(input.batchId);
  if (!batchId) {
    return linkError("BATCH_NOT_FOUND", "The selected batch does not exist");
  }
  const batch = (await client.batch.findUnique({
    where: { id: batchId },
    select: LINK_BATCH_SELECT,
  })) as { id: string; schoolType: string | null; courseId: string | null } | null;
  if (!batch) {
    return linkError("BATCH_NOT_FOUND", "The selected batch does not exist");
  }

  // 5. ONE course — per the system's actual batch model. A batch is a
  //    school-type audience pool: readiness (src/lib/session-lifecycle.ts)
  //    and student visibility resolve videos purely by batch.schoolType, and
  //    the Admin batch UI creates batches WITHOUT a course. So the course
  //    constraint binds only when the batch DECLARES a course: then the
  //    lesson must belong to exactly that course — and a lesson whose course
  //    cannot be proven is refused rather than guessed. A pool batch (no
  //    course) imposes no course constraint; the track rule above remains
  //    the real eligibility gate.
  const lessonCourseId =
    lesson.unit?.part?.courseId ?? lesson.topic?.unit?.part?.courseId ?? null;
  const batchCourseId = batch.courseId ?? null;
  if (batchCourseId !== null && lessonCourseId !== batchCourseId) {
    return linkError(
      "COURSE_MISMATCH",
      "The lesson and the batch belong to different courses"
    );
  }

  // 6. Track fit — the same predicate readiness applies, so a video the admin
  //    can create is exactly the video readiness counts:
  //      SHARED lesson   → either batch
  //      ARABIC lesson   → ARABIC batch only
  //      LANGUAGE lesson → LANGUAGE batch only
  const scope = normalizeTrackScope(lesson.trackScope);
  const schoolType = normalizeSchoolType(batch.schoolType);
  if (!scope || !schoolType || (scope !== "SHARED" && scope !== schoolType)) {
    return linkError(
      "TRACK_MISMATCH",
      "The lesson track is incompatible with the selected batch"
    );
  }

  return { ok: true, lessonId, batchId };
}

export type AbsentSessionLinkClient = Pick<typeof db, "liveSession" | "batch">;

export type AbsentSessionLinkResult =
  | { ok: true; liveSessionId: string }
  | { ok: false; code: "ABSENT_SESSION_INVALID"; status: number; message: string };

/**
 * The single database validator for an ABSENT_STUDENTS recording's linked
 * LiveSession. The absence source must be REAL and COMPATIBLE:
 *   1. The session exists.
 *   2. It is not CANCELLED (a cancelled class has no meaningful absentees).
 *   3. It belongs to the video's course (session.group.courseId ===
 *      batch.courseId). A batch WITHOUT a course (legacy null) cannot prove
 *      course membership, so the rule tightens instead: the session must be
 *      linked to THIS lesson exactly (no lesson-inference, no guessing).
 *   4. It is lesson-compatible: session.lessonId is null (a general session
 *      the admin explicitly attaches) or equals the video's lessonId.
 * Finalization is deliberately NOT required here: a recording may be
 * published before the teacher locks the register — applicability simply
 * stays EXEMPT_NOT_FINALIZED until the lock lands.
 */
export async function validateAbsentSessionLink(
  client: AbsentSessionLinkClient,
  input: { liveSessionId?: unknown; lessonId?: unknown; batchId?: unknown }
): Promise<AbsentSessionLinkResult> {
  const refuse = (message: string): AbsentSessionLinkResult => ({
    ok: false,
    code: "ABSENT_SESSION_INVALID",
    status: SESSION_VIDEO_REQUIREMENT_ERRORS.ABSENT_SESSION_INVALID.status,
    message,
  });
  const liveSessionId = asTrimmedId(input.liveSessionId);
  const lessonId = asTrimmedId(input.lessonId);
  const batchId = asTrimmedId(input.batchId);
  if (!liveSessionId || !lessonId || !batchId) {
    return refuse("a linked session, lesson and batch are all required");
  }
  const session = await client.liveSession.findUnique({
    where: { id: liveSessionId },
    select: {
      id: true,
      status: true,
      lessonId: true,
      group: { select: { courseId: true } },
    },
  });
  if (!session) return refuse("the linked live session does not exist");
  if (String(session.status ?? "").toUpperCase() === "CANCELLED") {
    return refuse("the linked live session is cancelled");
  }
  const sessionLessonId = (session.lessonId as string | null) ?? null;
  if (sessionLessonId !== null && sessionLessonId !== lessonId) {
    return refuse("the linked live session belongs to a different lesson");
  }
  const batch = await client.batch.findUnique({
    where: { id: batchId },
    select: { courseId: true },
  });
  const batchCourseId = (batch?.courseId as string | null) ?? null;
  if (batchCourseId !== null) {
    const sessionCourseId = (session.group as { courseId: string | null } | null)?.courseId ?? null;
    if (sessionCourseId !== batchCourseId) {
      return refuse("the linked live session belongs to a different course");
    }
  } else if (sessionLessonId !== lessonId) {
    // No course anchor exists on this batch, so only an exact lesson link
    // proves the session covers THIS video's absence.
    return refuse("the linked live session must belong to this lesson");
  }
  return { ok: true, liveSessionId };
}

/**
 * Client-side mirror of rule 6 (pure, no I/O) — the Admin UI uses it to show
 * only the lessons a selected batch can legally hold. The server ALWAYS
 * re-validates; this never widens what the server accepts.
 */
export function lessonFitsBatch(
  lessonTrackScope: unknown,
  batchSchoolType: unknown
): boolean {
  const scope = normalizeTrackScope(lessonTrackScope);
  const schoolType = normalizeSchoolType(batchSchoolType);
  if (!schoolType) return false;
  if (!scope) return false;
  return scope === "SHARED" || scope === schoolType;
}

// ---------------------------------------------------------------------------
// Progression requirement validation (REQUIRED-vs-OPTIONAL per video).
// ---------------------------------------------------------------------------
// The SINGLE server-side authority that decides whether a SessionVideo row
// may carry `isRequiredForProgression = true` and which completion threshold
// (`requiredPercent`) it enforces. Every write path — the buffered Admin POST
// (multipart + JSON), the Admin PATCH edit, and the presigned-upload complete
// — parses through `parseSessionVideoRequirement`, so the three can never
// drift apart.
//
// THE RULES (fail-closed, in order — no silent correction ever):
//   1. `requiredPercent`, when provided, must be a finite number from 50
//      through 100 inclusive. Out-of-range values are REFUSED — never
//      clamped, never rounded into validity (49.9 and 100.1 are 422s, not
//      50 and 100): the threshold drives progression and the platform must
//      never silently rewrite an admin's threshold. Absent/blank means "no
//      opinion" → the schema default 95. Garbage (NaN, Infinity, non-numeric
//      text) is refused, never coerced.  → INVALID_REQUIRED_PERCENT (422)
//      In-range decimals (e.g. 85.4) round half-up AFTER passing the range
//      gate — the column is an Int, so this representation rule is the only
//      transformation the parser performs, and it is documented here.
//   2. `isRequiredForProgression = true` is refused unless the row's media is
//      TRACKABLE — managed private bytes (LOCAL_PRIVATE / S3) the server
//      meters through the heartbeat. An EXTERNAL_URL row has no reliable
//      server watch %, so a threshold requirement on it would be unpassable
//      by construction; the refusal names that, and the row stays OPTIONAL.
//      Untrackability is NOT silently converted into "not required": the
//      write is rejected and the admin must choose.
//                                             → EXTERNAL_CANNOT_BE_REQUIRED (422)
//
// Publication is orthogonal: a REQUIRED-but-unpublished video is staged, not
// contradictory — publish activates the requirement, it does not define it.

export const SESSION_VIDEO_REQUIREMENT_ERRORS = {
  EXTERNAL_CANNOT_BE_REQUIRED: { status: 422, i18n: "api.360" },
  INVALID_REQUIRED_PERCENT: { status: 422, i18n: "api.361" },
  INVALID_REQUIREMENT_MODE: { status: 422, i18n: "api.362" },
  ABSENT_REQUIRES_LESSON: { status: 422, i18n: "api.363" },
  ABSENT_REQUIRES_SESSION: { status: 422, i18n: "api.364" },
  ABSENT_SESSION_INVALID: { status: 422, i18n: "api.365" },
} as const;

export type SessionVideoRequirementCode =
  keyof typeof SESSION_VIDEO_REQUIREMENT_ERRORS;

export type SessionVideoRequirementResult =
  | {
      ok: true;
      isRequired: boolean;
      requiredPercent: number;
      requirementMode: RequirementMode;
      /** The absence-source session (ABSENT_STUDENTS only; else null). */
      liveSessionId: string | null;
    }
  | { ok: false; code: SessionVideoRequirementCode; status: number; message: string };

/** Schema default, mirroring VIDEO_COMPLETION_THRESHOLD (95%). */
export const SESSION_VIDEO_DEFAULT_REQUIRED_PERCENT = 95;
/** The existing PATCH range rule (50–100), now shared by every write path. */
export const SESSION_VIDEO_MIN_REQUIRED_PERCENT = 50;
export const SESSION_VIDEO_MAX_REQUIRED_PERCENT = 100;

export function parseSessionVideoRequirement(
  input: {
    isRequiredForProgression?: unknown;
    requirementMode?: unknown;
    liveSessionId?: unknown;
    requiredPercent?: unknown;
  },
  opts: { storage: unknown; lessonId?: unknown }
): SessionVideoRequirementResult {
  // Mode resolution: an explicitly-provided mode wins (and garbage is
  // refused, never coerced); an omitted mode falls back to the legacy flag
  // (true → ALL_STUDENTS, anything else → OPTIONAL) for older clients.
  // Multipart transports carry "true" (string); JSON carries true (boolean).
  const modeProvided =
    input.requirementMode !== undefined &&
    input.requirementMode !== null &&
    !(typeof input.requirementMode === "string" && input.requirementMode.trim() === "");
  const parsedMode = modeProvided ? normalizeRequirementMode(input.requirementMode) : null;
  if (modeProvided && !parsedMode) {
    return {
      ok: false,
      code: "INVALID_REQUIREMENT_MODE",
      status: SESSION_VIDEO_REQUIREMENT_ERRORS.INVALID_REQUIREMENT_MODE.status,
      message: "requirementMode must be one of OPTIONAL, ALL_STUDENTS, ABSENT_STUDENTS",
    };
  }
  const flag = input.isRequiredForProgression;
  const requirementMode: RequirementMode =
    parsedMode ?? (flag === true || flag === "true" ? "ALL_STUDENTS" : "OPTIONAL");
  const isRequired = requirementMode !== "OPTIONAL";

  // ABSENT_STUDENTS presence contract (no DB needed): the mode is meaningless
  // without a lesson home (the absence to cover lives under a lesson) and
  // without the explicit absence-source session. Both are refused with their
  // OWN codes (never the generic link errors): the requirement contract —
  // not the link contract — decides what a requirement needs. Non-ABSENT
  // modes persist no link: a session id sent alongside OPTIONAL/ALL_STUDENTS
  // is dropped (it has no meaning there), so leaving ABSENT_STUDENTS can
  // never strand a stale absence source on the row.
  let liveSessionId: string | null = null;
  if (requirementMode === "ABSENT_STUDENTS") {
    if (!asTrimmedId(opts.lessonId)) {
      return {
        ok: false,
        code: "ABSENT_REQUIRES_LESSON",
        status: SESSION_VIDEO_REQUIREMENT_ERRORS.ABSENT_REQUIRES_LESSON.status,
        message: "absent-only mode requires the video to be linked to a lesson",
      };
    }
    liveSessionId = asTrimmedId(input.liveSessionId);
    if (!liveSessionId) {
      return {
        ok: false,
        code: "ABSENT_REQUIRES_SESSION",
        status: SESSION_VIDEO_REQUIREMENT_ERRORS.ABSENT_REQUIRES_SESSION.status,
        message: "absent-only mode requires the linked live session",
      };
    }
  }

  let requiredPercent = SESSION_VIDEO_DEFAULT_REQUIRED_PERCENT;
  const raw = input.requiredPercent;
  const blankString = typeof raw === "string" && raw.trim() === "";
  if (raw !== undefined && raw !== null && !blankString) {
    const n = Number(raw);
    const refusePercent = {
      ok: false as const,
      code: "INVALID_REQUIRED_PERCENT" as const,
      status: SESSION_VIDEO_REQUIREMENT_ERRORS.INVALID_REQUIRED_PERCENT.status,
      message: "requiredPercent must be a number between 50 and 100",
    };
    if (!Number.isFinite(n)) return refusePercent;
    // NO CLAMPING, NO rescue rounding: the range gate runs on the RAW value,
    // so 49, 101, 49.9 and 100.1 are all refused. Only values already inside
    // [50, 100] reach the documented Int rounding below.
    if (n < SESSION_VIDEO_MIN_REQUIRED_PERCENT || n > SESSION_VIDEO_MAX_REQUIRED_PERCENT) {
      return refusePercent;
    }
    requiredPercent = Math.round(n);
  }

  if (isRequired && !isManagedPrivateStorage(opts.storage)) {
    return {
      ok: false,
      code: "EXTERNAL_CANNOT_BE_REQUIRED",
      status: SESSION_VIDEO_REQUIREMENT_ERRORS.EXTERNAL_CANNOT_BE_REQUIRED.status,
      message: "an external (untrackable) video cannot be required for lesson completion",
    };
  }

  return { ok: true, isRequired, requiredPercent, requirementMode, liveSessionId };
}
