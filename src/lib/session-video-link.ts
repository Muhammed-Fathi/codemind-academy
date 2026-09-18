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
//   5. Lesson and Batch belong to ONE course  → COURSE_MISMATCH
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

  // 5. ONE course. The lesson's course is resolved through its real chain
  //    (canonical unit chain first, legacy topic chain as fallback) and must
  //    equal the batch's course. Null on either side is a refusal: a link
  //    whose course cannot be proven the same is a cross-course link.
  const lessonCourseId =
    lesson.unit?.part?.courseId ?? lesson.topic?.unit?.part?.courseId ?? null;
  const batchCourseId = batch.courseId ?? null;
  if (lessonCourseId !== batchCourseId) {
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
